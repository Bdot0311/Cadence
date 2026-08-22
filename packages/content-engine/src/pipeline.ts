import { createHash } from 'node:crypto';
import type { Violation } from './detectors.js';
import {
  PRODUCT_FACTS_PROMPT,
  checkFacts,
  hasRejects,
  type FactViolation,
} from './company-facts.js';
import type { ModelClient } from './model.js';
import { formatViolationsForRetry, runSlopGate } from './slop-gate.js';

export const DRAFTING_PROMPT_VERSION = 'drafting/v1';

/** Max regeneration loops before the draft is killed. */
export const MAX_GATE_LOOPS = 5;

export interface VoiceProfile {
  sentenceLength: { mean: number; stddev: number };
  openerPatterns: string[];
  vocabulary: { favored: string[]; avoided: string[] };
  structuralHabits: string[];
  lineBreakStyle: string;
}

export interface CtaPolicy {
  /** 'comment_gate' | 'none' */
  mechanic: string;
  productNameInBody: boolean;
  /** 'signup' | 'none' */
  destination: string;
}

/** A belief on file, from the founder_pov table. Never invented. */
export interface FounderBelief {
  label: string;
  belief: string;
  challenges?: string | null;
  evidence?: string | null;
}

export type PillarKind = 'founder' | 'product';

export interface DraftRequest {
  angle: string;
  pillarName: string;
  pillarDescription: string;
  /**
   * founder = the operator's thinking is the subject and the product is only
   * evidence. product = the product or its domain is the subject.
   *
   * This is the lever the Aug 2026 audit turns on. Before it existed, every
   * post was product-first because drafting had no other mode.
   */
  pillarKind: PillarKind;
  voiceProfile: VoiceProfile;
  ctaPolicy: CtaPolicy;
  blockedTopics: string[];
  blockedClaims: string[];
  /** Facts the post may draw on. Anything not here is invented specificity. */
  sourceContext: string;
  /** Who the post is written for. Audit finding 4. */
  primaryAudience?: string;
  /**
   * Beliefs on file. Empty is normal and must stay safe: a founder-POV post
   * with no belief to argue is skipped, never improvised. An invented belief
   * is not the founder's point of view.
   */
  beliefs?: FounderBelief[];
}

export type DraftOutcome =
  | {
      status: 'approved';
      body: string;
      structureHash: string;
      loops: number;
      promptVersion: string;
      usage: { inputTokens: number; outputTokens: number };
    }
  | {
      status: 'killed';
      reason: string;
      violations: Violation[];
      factViolations: FactViolation[];
      loops: number;
      lastDraft: string;
      promptVersion: string;
      usage: { inputTokens: number; outputTokens: number };
    };

function draftingSystem(req: DraftRequest): string {
  const v = req.voiceProfile;
  return [
    'You write LinkedIn posts in the founder\'s own voice. You are not a brand account.',
    '',
    'VOICE. Match these observed habits from the founder\'s best-performing posts:',
    `- Sentence length averages ${v.sentenceLength.mean} words (stddev ${v.sentenceLength.stddev}). Vary deliberately; do not write uniform sentences.`,
    `- Openers he actually uses: ${v.openerPatterns.map((p) => JSON.stringify(p)).join(', ')}`,
    `- Words he reaches for: ${v.vocabulary.favored.join(', ')}`,
    `- Words he never uses: ${v.vocabulary.avoided.join(', ')}`,
    `- Structural habits: ${v.structuralHabits.join('; ')}`,
    `- Line breaks: ${v.lineBreakStyle}`,
    '',
    'REGISTER. Direct, terse, confident. No coaching tone. No over-explaining. No filler.',
    'State recommendations rather than hedging. Write how he would actually write it,',
    'not how an AI defaults.',
    '',
    'LENGTH. Long-form is fine and often better. Do not pad to reach a length, and do',
    'not compress a real idea into fragments. Write until the point is made.',
    '',
    positioningBlock(req),
    '',
    PRODUCT_FACTS_PROMPT,
    '',
    'HARD FORMATTING RULES. These are checked mechanically after you write. A single',
    'instance fails the draft:',
    '- No em dashes or en dashes. Use commas, colons, or periods.',
    '- No rule-of-three lists.',
    '- No "not X, but Y" constructions in any shape.',
    '- No "I\'m excited to announce" or any variant.',
    '- Do not open on a rhetorical question.',
    '- No more than 5 consecutive single-sentence lines.',
    '- No emoji, arrows, or decorative unicode.',
    '',
    ctaInstruction(req.ctaPolicy),
    '',
    req.blockedTopics.length > 0
      ? `NEVER write about: ${req.blockedTopics.join(', ')}.`
      : '',
    req.blockedClaims.length > 0
      ? `NEVER make these claims: ${req.blockedClaims.join('; ')}.`
      : '',
    '',
    'Return only the post body. No title, no preamble, no commentary about the post.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Founder-vs-product positioning. This is the Aug 2026 audit's core fix.
 *
 * The audit's six findings all reduce to one thing: the content was product
 * first. Cadence was causing that, not merely allowing it — drafting injected
 * the product facts and a signup CTA into every post regardless of pillar, so
 * "problem, lesson, product, CTA" was the only shape it could produce.
 *
 * For founder pillars the product becomes evidence rather than subject. The
 * product facts stay in the prompt either way, because a founder post must
 * still never contradict them.
 */
function positioningBlock(req: DraftRequest): string {
  const audience =
    req.primaryAudience ?? 'Founders, CEOs, and sales leaders at B2B companies';

  if (req.pillarKind === 'product') {
    return [
      'POSITIONING. This is a product-domain post.',
      `Written for: ${audience}.`,
      'Lead with the reader\'s problem, not the capability. Name the product only',
      'where the CTA policy allows it. Even here, the reader should finish with a',
      'view about the problem, not a feature list.',
    ].join('\n');
  }

  const lines = [
    'POSITIONING. This is a FOUNDER post. The subject is how the founder thinks.',
    `Written for: ${audience}. Peers carrying the same load, not evaluators of a tool.`,
    '',
    'Rules for this post:',
    '- The product is EVIDENCE, never the subject. It may appear once, as proof',
    '  that a belief survived contact with reality. If the post still works with',
    '  the product removed, that is correct.',
    '- Argue something. A post that only explains a best practice fails this',
    '  pillar; the audit\'s finding was that the content teaches rather than',
    '  takes a position.',
    '- Ground it in something that actually happened: a decision, a cost, a call',
    '  that went wrong. Do not invent the specifics.',
    '- Do not pivot to how early the company was or how the market is catching up.',
  ];

  const beliefs = req.beliefs ?? [];
  if (beliefs.length > 0) {
    lines.push('', 'BELIEFS ON FILE. Argue from one of these. Do not invent a new one:');
    for (const b of beliefs) {
      lines.push(`- ${b.label}: ${b.belief}`);
      if (b.challenges) lines.push(`  Pushes against: ${b.challenges}`);
      if (b.evidence) lines.push(`  Evidence: ${b.evidence}`);
    }
  } else {
    // Safe degradation. An invented belief is not the founder's point of view,
    // and company-context forbids fabricated claims. Better to write from
    // documented experience than to manufacture a position.
    lines.push(
      '',
      'NO BELIEFS ARE ON FILE. Do not invent one and do not attribute an opinion',
      'to the founder that is not in the source material. Write from what the',
      'source actually supports, and keep the claim proportionate to it.',
    );
  }

  return lines.join('\n');
}

function ctaInstruction(cta: CtaPolicy): string {
  const parts: string[] = ['CTA POLICY.'];
  if (cta.mechanic === 'comment_gate') {
    parts.push(
      'End with a comment-gate: ask the reader to comment a specific single word to',
      'receive the thing. Make the word short and easy to type. The gate must feel',
      'like a natural extension of the post, not a bolt-on.',
    );
  } else if (cta.mechanic === 'discussion') {
    // Audit finding 2: "Most CTAs ask people to try OutReign instead of
    // engaging with your perspective." A thought-leadership post that closes on
    // a signup ask is a product post wearing a founder's voice.
    parts.push(
      'Close by inviting disagreement or a counter-example, in one line, on the',
      'specific claim you just made. Do not ask for a signup, a download, a demo,',
      'or a comment-gate keyword. Do not ask a generic "what do you think".',
      'Name the thing you want pushback on.',
    );
  } else {
    parts.push('No call to action. End on the last substantive point.');
  }
  if (!cta.productNameInBody) {
    parts.push(
      'Do NOT name the product anywhere in the body. The idea carries the post.',
    );
  }
  if (cta.destination === 'signup') {
    parts.push(
      'The thing being offered leads to a signup, not to a PDF, deck, or external asset.',
    );
  }
  return parts.join('\n');
}

/**
 * Structural fingerprint, used to block two structurally similar posts inside
 * 10 days.
 *
 * Hashes the SHAPE, not the words: paragraph count, the length bucket of each
 * paragraph, and whether the post opens on a question or a statement. Two posts
 * about different topics with an identical skeleton collide, which is the
 * intent — a feed of same-shaped posts reads as machine output no matter how
 * varied the subjects are.
 */
export function structureHash(body: string): string {
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const skeleton = paras
    .map((p) => {
      const words = p.split(/\s+/).length;
      const bucket = words < 15 ? 'S' : words < 40 ? 'M' : 'L';
      const sentenceCount = p.split(/(?<=[.!?])\s+/).filter(Boolean).length;
      return `${bucket}${sentenceCount}`;
    })
    .join('.');

  const opensOnQuestion = /\?\s*$/.test(paras[0]?.split('\n')[0] ?? '');
  return createHash('sha256')
    .update(`${paras.length}|${skeleton}|${opensOnQuestion ? 'Q' : 'S'}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Draft → slop gate → fact gate, looping on failure up to MAX_GATE_LOOPS.
 *
 * A killed draft is a better outcome than a mediocre published one, so the loop
 * gives up rather than lowering the bar. Everything about why it died is
 * returned for `post_queue.gate_violations`.
 */
export async function draftWithGates(args: {
  request: DraftRequest;
  model: ModelClient;
}): Promise<DraftOutcome> {
  const { request: req, model } = args;
  const system = draftingSystem(req);

  let userMessage = [
    `Angle to write: ${req.angle}`,
    '',
    `Content pillar: ${req.pillarName} — ${req.pillarDescription}`,
    '',
    'Facts you may draw on. Anything not here is off-limits; do not invent numbers,',
    'dates, or named moments:',
    `<source>\n${req.sourceContext}\n</source>`,
  ].join('\n');

  let lastDraft = '';
  let lastSlop: Violation[] = [];
  let lastFacts: FactViolation[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let loop = 1; loop <= MAX_GATE_LOOPS; loop++) {
    const drafted = await model.text({
      system,
      user: userMessage,
      effort: loop === 1 ? 'medium' : 'high', // escalate on retry
    });
    inputTokens += drafted.inputTokens;
    outputTokens += drafted.outputTokens;

    if (drafted.refusal) {
      return {
        status: 'killed',
        reason: `Drafting was declined by the model (${drafted.refusal.category ?? 'unknown'}).`,
        violations: [],
        factViolations: [],
        loops: loop,
        lastDraft: '',
        promptVersion: DRAFTING_PROMPT_VERSION,
        usage: { inputTokens, outputTokens },
      };
    }

    lastDraft = drafted.value;

    // Fact gate first. It is deterministic and free, and a product-fact
    // violation is a harder failure than a stylistic one.
    lastFacts = checkFacts({
      text: lastDraft,
      blockedClaims: req.blockedClaims,
      blockedTopics: req.blockedTopics,
    });

    const slop = await runSlopGate({
      draft: lastDraft,
      model,
      sourceContext: req.sourceContext,
      // Without this the critique pass flags the comment-gate CTA that the
      // drafting prompt just required, and no draft can ever pass.
      ctaPolicy: req.ctaPolicy,
    });
    if (slop.usage) {
      inputTokens += slop.usage.inputTokens;
      outputTokens += slop.usage.outputTokens;
    }
    lastSlop = slop.violations;

    const factBlocking = hasRejects(lastFacts);
    const factCuts = lastFacts.filter((f) => f.action === 'cut');

    if (slop.pass && !factBlocking && factCuts.length === 0) {
      return {
        status: 'approved',
        body: lastDraft,
        structureHash: structureHash(lastDraft),
        loops: loop,
        promptVersion: `${DRAFTING_PROMPT_VERSION}+${slop.promptVersion}`,
        usage: { inputTokens, outputTokens },
      };
    }

    userMessage = [
      userMessage.split('\n\nYour previous draft')[0],
      '',
      'The original angle wording is not binding. Preserve only the grounded subject and rebuild the framing from a direct affirmative claim.',
      'Do not reuse any sentence structure named in the violations.',
      '',
      `Your previous draft:\n<draft>\n${lastDraft}\n</draft>`,
      '',
      lastFacts.length > 0 ? formatFactViolations(lastFacts) : '',
      lastSlop.length > 0 ? formatViolationsForRetry(lastSlop) : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return {
    status: 'killed',
    reason: `Failed the editorial gate ${MAX_GATE_LOOPS} times. A killed draft beats a mediocre published one.`,
    violations: lastSlop,
    factViolations: lastFacts,
    loops: MAX_GATE_LOOPS,
    lastDraft,
    promptVersion: DRAFTING_PROMPT_VERSION,
    usage: { inputTokens, outputTokens },
  };
}

function formatFactViolations(violations: FactViolation[]): string {
  const rejects = violations.filter((v) => v.action === 'reject');
  const cuts = violations.filter((v) => v.action === 'cut');
  const out: string[] = ['Your previous draft failed the fact gate.'];

  if (rejects.length > 0) {
    out.push(
      '',
      'FACTUALLY WRONG. These contradict the product. Remove them entirely:',
      ...rejects.map((v) => `- [${v.code}] ${v.message}\n  Found: ${JSON.stringify(v.evidence)}`),
    );
  }
  if (cuts.length > 0) {
    out.push(
      '',
      'UNVERIFIABLE. Cut the sentence containing each. Do not soften it, do not',
      'replace the number with a vaguer number:',
      ...cuts.map((v) => `- [${v.code}] ${v.message}\n  Found: ${JSON.stringify(v.evidence)}`),
    );
  }
  return out.join('\n');
}
