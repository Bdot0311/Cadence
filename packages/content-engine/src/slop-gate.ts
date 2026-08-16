import { z } from 'zod';
import { detectSlop, hasBlockingViolations, type Violation } from './detectors.js';
import type { ModelClient } from './model.js';

export const SLOP_GATE_PROMPT_VERSION = 'slop-gate/v1';

/**
 * The slop gate. Two layers, run in order.
 *
 *   Layer 1 — deterministic detectors. Cheap, exact, unarguable.
 *   Layer 2 — an LLM critique pass for the semantic patterns regex can't see.
 *
 * Layer 1 runs first and short-circuits. A draft with an em dash in it does not
 * need a model call to be told so, and skipping that call is the difference
 * between a gate that runs on every regeneration and one that's too expensive
 * to run on every regeneration.
 *
 * The critique pass is a SEPARATE call from drafting, deliberately. A model
 * asked to write and self-assess in one turn grades its own homework and
 * passes. Fresh context, checklist framing, and an explicit instruction that
 * coverage beats politeness.
 */

const CritiqueResult = z.object({
  violations: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      evidence: z.string(),
    }),
  ),
});

const CRITIQUE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    violations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            enum: [
              'negative-parallelism',
              'false-suspense',
              'self-answered-question',
              'colon-setup',
              'formulaic-opener',
              'formulaic-closer',
              'patronising-analogy',
              'manufactured-stakes',
              'invented-specificity',
              'pedagogical-framing',
              'vague-authority',
              'swap-framing',
              'forced-empathy',
              'empty-intensifier',
              'metaphorical-verb',
              'clustering-vocabulary',
              'clustering-structure',
              'one-point-dilution',
              'sales-pitch-pivot',
            ],
          },
          message: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['code', 'message', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['violations'],
  additionalProperties: false,
} as const;

const CRITIQUE_SYSTEM = `
You are a copy editor applying a fixed checklist to a LinkedIn post. You do not
rewrite. You report violations so a separate step can fix them.

Report every violation you find, including ones you are uncertain about. Do not
filter for importance — a later step ranks and fixes them. It is better to
surface something that gets dismissed than to let a tell ship. Return an empty
array only when the draft is genuinely clean.

CHECKLIST — PASS ONE. Zero tolerance. Any instance is a violation.

negative-parallelism: asserting what something IS by first saying what it ISN'T
  about the same subject. Every shape counts: "it's not X, it's Y", "not just X,
  Y", "don't just X, Y", "it's less X, more Y", "it feels like A but it's
  actually B", "you'd expect X, you get Y", "X was never A, it's B". Test: remove
  the negated half — if the point still stands, the negation was scaffolding.
  DO NOT flag different-subject contrast ("big clients don't buy software, they
  buy the safest choice") or a genuine state-shift where the subject actually
  moved from A to B.
false-suspense: a transition that teases a revelation instead of naming it.
  "Here's the thing", "here's what nobody tells you", "here's what changed".
  Test: does it name the revelation in the same beat, or only promise one?
self-answered-question: posing a question and answering it in the same beat.
colon-setup: abstract noun, colon, payoff. "The reality:", "The takeaway:".
  Also the mid-sentence version: setup clause, colon, payoff.
formulaic-opener: stock opening frames, and humblebrag announcement openers.
formulaic-closer: announcing the conclusion instead of just making the last point.
patronising-analogy: "think of it like", "it's like", "imagine if". Even one.
manufactured-stakes: grandiose inflation ("reshapes everything") or
  phantom-future projection ("a year from now you'll wish"). Real stakes come
  from a present cost the reader already pays.
invented-specificity: any number, date, percentage, or named moment not present
  in the source material given to you. Also coining an abstract compound phrase
  and using it as an established term.
pedagogical-framing: teacher voice. "Let's unpack", "let's break this down".
vague-authority: "research shows", "experts say", with no named source.
swap-framing: "say goodbye to X, say hello to Y".
forced-empathy: "you're not alone", "you're not imagining it".
empty-intensifier: "actually works", "genuinely helps" — unearned contrast.
metaphorical-verb: a metaphor where a literal verb is clearer ("collapses" for
  "stops working", "dovetails into" for "connects to").

CHECKLIST — PASS TWO. Clustering. Flag only when STACKED, not on one instance.

clustering-vocabulary: a pile-up of grandiose nouns, inflated adjectives, magic
  adverbs, or pompous verbs. One strong adjective is human; a wall is not.
clustering-structure: multiple rule-of-three lists, uniform sentence and
  paragraph lengths, or the same sentence opener three or more times.
one-point-dilution: restating a single argument several ways.

HOUSE RULE.

sales-pitch-pivot: the post must not close by circling back to how early the
  company was, how it built this before anyone asked, or how the market is
  catching up. The value is the idea. Many posts should not name the product.

Judge only what is in the draft. Do not suggest additions. Do not reward the
draft for what it avoids.
`.trim();

export interface SlopGateResult {
  pass: boolean;
  violations: Violation[];
  /** Null when layer 1 short-circuited before any model call. */
  usage: { inputTokens: number; outputTokens: number } | null;
  promptVersion: string;
}

export async function runSlopGate(args: {
  draft: string;
  model: ModelClient;
  /** Source material the draft was written from, so invented specificity can be judged. */
  sourceContext?: string;
}): Promise<SlopGateResult> {
  const deterministic = detectSlop(args.draft);

  // Short-circuit: a draft that already fails a hard check does not need a
  // model call to confirm it. The regeneration loop gets the violations it
  // needs from layer 1 alone.
  if (hasBlockingViolations(deterministic)) {
    return {
      pass: false,
      violations: deterministic,
      usage: null,
      promptVersion: SLOP_GATE_PROMPT_VERSION,
    };
  }

  const critique = await args.model.structured({
    schema: CritiqueResult,
    jsonSchema: CRITIQUE_JSON_SCHEMA as unknown as Record<string, unknown>,
    system: CRITIQUE_SYSTEM,
    // Gate judgment is load-bearing. Run it at high effort regardless of what
    // drafting used.
    effort: 'high',
    user: [
      args.sourceContext
        ? `Source material the draft was written from:\n<source>\n${args.sourceContext}\n</source>\n`
        : 'No source material was provided. Treat ANY specific number, date, or named moment as invented-specificity.\n',
      `Draft to check:\n<draft>\n${args.draft}\n</draft>`,
    ].join('\n'),
  });

  if (critique.refusal) {
    // A refused critique is not a pass. Fail closed.
    return {
      pass: false,
      violations: [
        ...deterministic,
        {
          code: 'critique-refused',
          severity: 'zero-tolerance',
          message: `Critique pass was declined (${critique.refusal.category ?? 'unknown'}). Failing closed.`,
          evidence: critique.refusal.explanation ?? '',
        },
      ],
      usage: { inputTokens: critique.inputTokens, outputTokens: critique.outputTokens },
      promptVersion: SLOP_GATE_PROMPT_VERSION,
    };
  }

  const semantic: Violation[] = critique.value.violations.map((v) => ({
    code: v.code,
    // Clustering codes are advisory; everything else on this checklist blocks.
    severity: v.code.startsWith('clustering-') || v.code === 'one-point-dilution'
      ? 'clustering'
      : 'zero-tolerance',
    message: v.message,
    evidence: v.evidence,
  }));

  const all = [...deterministic, ...semantic];

  return {
    pass: !hasBlockingViolations(all),
    violations: all,
    usage: { inputTokens: critique.inputTokens, outputTokens: critique.outputTokens },
    promptVersion: SLOP_GATE_PROMPT_VERSION,
  };
}

/** Renders violations into the correction block fed back to the drafting step. */
export function formatViolationsForRetry(violations: Violation[]): string {
  const blocking = violations.filter((v) => v.severity === 'zero-tolerance');
  const advisory = violations.filter((v) => v.severity === 'clustering');

  const lines: string[] = [
    'Your previous draft failed the editorial gate. Fix every item below and return a new draft.',
    '',
    'MUST FIX:',
    ...blocking.map((v) => `- [${v.code}] ${v.message}\n  Found: ${JSON.stringify(v.evidence)}`),
  ];

  if (advisory.length > 0) {
    lines.push('', 'ALSO CONSIDER:', ...advisory.map((v) => `- [${v.code}] ${v.message}`));
  }

  lines.push(
    '',
    'Do not soften these. Rewrite the affected lines. Do not introduce new instances of any pattern while fixing another.',
  );

  return lines.join('\n');
}
