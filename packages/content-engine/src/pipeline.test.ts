import { describe, expect, it } from 'vitest';
import { MAX_GATE_LOOPS, draftWithGates, structureHash } from './pipeline.js';
import type { ModelClient } from './model.js';
import type { CtaPolicy, DraftRequest, VoiceProfile } from './pipeline.js';

// --- fake model -------------------------------------------------------------

/**
 * Returns the supplied drafts in order, and always passes the critique step.
 * Layer-1 detectors do the real work in these tests, which is the point: the
 * gate's teeth must not depend on model judgment.
 */
function fakeModel(drafts: string[]): {
  model: ModelClient;
  textCalls: string[];
  critiqueCalls: number;
} {
  const textCalls: string[] = [];
  let i = 0;
  let critiqueCalls = 0;

  const model = {
    async text(args: { user: string }) {
      textCalls.push(args.user);
      const value = drafts[Math.min(i++, drafts.length - 1)] ?? '';
      return { value, inputTokens: 100, outputTokens: 200, refusal: null };
    },
    async structured() {
      critiqueCalls++;
      return {
        value: { violations: [] },
        inputTokens: 50,
        outputTokens: 20,
        refusal: null,
      };
    },
  } as unknown as ModelClient;

  return {
    model,
    textCalls,
    get critiqueCalls() {
      return critiqueCalls;
    },
  };
}

const voice: VoiceProfile = {
  sentenceLength: { mean: 14, stddev: 6 },
  openerPatterns: ['Most X fails because'],
  vocabulary: { favored: ['signal', 'reply'], avoided: ['leverage'] },
  structuralHabits: ['short opener, then a paragraph of reasoning'],
  lineBreakStyle: 'blank line between paragraphs',
};

const cta: CtaPolicy = {
  mechanic: 'comment_gate',
  productNameInBody: false,
  destination: 'signup',
};

function request(overrides: Partial<DraftRequest> = {}): DraftRequest {
  return {
    angle: 'Why list quality beats copy quality in outbound',
    pillarName: 'Outbound craft',
    pillarDescription: 'How outbound actually works, from someone doing it',
    pillarKind: 'product' as const,
    voiceProfile: voice,
    ctaPolicy: cta,
    blockedTopics: [],
    blockedClaims: [],
    sourceContext: 'Outreign scores accounts on live intent signals before writing.',
    ...overrides,
  };
}

const CLEAN_DRAFT = [
  'Most cold email fails because the list is wrong, and no amount of copy rescues a bad list.',
  '',
  'We rebuilt around that. Score the account on live intent signals first, then write to what the signal actually says.',
  '',
  'Sending volume went down. Replies went up. Comment "signal" and I will send you the scoring rubric we use.',
].join('\n');

// --- tests ------------------------------------------------------------------

describe('draftWithGates', () => {
  it('approves a clean draft on the first loop', async () => {
    const { model } = fakeModel([CLEAN_DRAFT]);
    const out = await draftWithGates({ request: request(), model });

    expect(out.status).toBe('approved');
    if (out.status !== 'approved') return;
    expect(out.loops).toBe(1);
    expect(out.body).toBe(CLEAN_DRAFT);
    expect(out.structureHash).toHaveLength(16);
  });

  it('retries with violations attached, then approves', async () => {
    const bad = "I'm excited to announce our new approach — it's not volume, it's signal.";
    const h = fakeModel([bad, CLEAN_DRAFT]);
    const out = await draftWithGates({ request: request(), model: h.model });

    expect(out.status).toBe('approved');
    if (out.status !== 'approved') return;
    expect(out.loops).toBe(2);

    // The retry prompt names the specific failures rather than saying "try again".
    const retryPrompt = h.textCalls[1] ?? '';
    expect(retryPrompt).toContain('MUST FIX');
    expect(retryPrompt).toContain('announcement-opener');
    expect(retryPrompt).toContain('em-dash');
    expect(retryPrompt).toContain('negative-parallelism');
  });

  it('kills the draft after MAX_GATE_LOOPS and records why', async () => {
    const alwaysBad = 'Thrilled to announce — we leverage a transformative approach.';
    const h = fakeModel([alwaysBad]);
    const out = await draftWithGates({ request: request(), model: h.model });

    expect(out.status).toBe('killed');
    if (out.status !== 'killed') return;
    expect(out.loops).toBe(MAX_GATE_LOOPS);
    expect(h.textCalls).toHaveLength(MAX_GATE_LOOPS);
    expect(out.reason).toMatch(/killed draft beats a mediocre published one/);

    // Violations survive for post_queue.gate_violations and the dashboard view.
    const codes = out.violations.map((v) => v.code);
    expect(codes).toContain('announcement-opener');
    expect(codes).toContain('em-dash');
    expect(codes).toContain('banned-word');
    expect(out.lastDraft).toBe(alwaysBad);
  });

  it('kills on a product-fact violation even when the prose is clean', async () => {
    const wrongFact = [
      'Most outbound fails on targeting.',
      '',
      'So we added a dialer that calls the account the moment intent fires. Comment "signal" for the rubric.',
    ].join('\n');

    const out = await draftWithGates({ request: request(), model: fakeModel([wrongFact]).model });

    expect(out.status).toBe('killed');
    if (out.status !== 'killed') return;
    expect(out.factViolations.map((f) => f.code)).toContain('outreign-is-email-only');
  });

  it('does not spend a critique call when layer 1 already failed', async () => {
    const h = fakeModel(['A draft with an em dash — right here.']);
    await draftWithGates({ request: request(), model: h.model });
    // Every drafting attempt short-circuits before the more expensive critique.
    expect(h.textCalls).toHaveLength(MAX_GATE_LOOPS);
    expect(h.critiqueCalls).toBe(0);
  });

  it('accumulates token usage across every loop', async () => {
    const out = await draftWithGates({
      request: request(),
      model: fakeModel(['Thrilled to announce this.']).model,
    });
    // Every configured attempt is included in the aggregate usage.
    expect(out.usage.inputTokens).toBe(MAX_GATE_LOOPS * 100);
    expect(out.usage.outputTokens).toBe(MAX_GATE_LOOPS * 200);
  });
});

describe('structureHash', () => {
  it('collides for posts with the same shape but different words', async () => {
    const a = 'One short opener here.\n\nA much longer second paragraph that runs on for a while and carries the reasoning of the post.';
    const b = 'Totally different words.\n\nAnother long paragraph with completely unrelated content that happens to run to a similar length overall.';
    expect(structureHash(a)).toBe(structureHash(b));
  });

  it('differs when the paragraph count changes', () => {
    const a = 'One.\n\nTwo.';
    const b = 'One.\n\nTwo.\n\nThree.';
    expect(structureHash(a)).not.toBe(structureHash(b));
  });

  it('differs when the post opens on a question', () => {
    const a = 'Why does outbound fail?\n\nBecause the list is wrong.';
    const b = 'Outbound fails a lot.\n\nBecause the list is wrong.';
    expect(structureHash(a)).not.toBe(structureHash(b));
  });
});

// --- founder vs product positioning (Aug 2026 LinkedIn audit) ---------------

describe('positioning', () => {
  function capture(overrides: Partial<DraftRequest>) {
    let system = '';
    const model = {
      async text(a: { system: string }) {
        system = a.system;
        return { value: CLEAN_DRAFT, inputTokens: 1, outputTokens: 1, refusal: null };
      },
      async structured() {
        return { value: { violations: [] }, inputTokens: 1, outputTokens: 1, refusal: null };
      },
    } as unknown as ModelClient;
    return draftWithGates({ request: request(overrides), model }).then(() => system);
  }

  it('makes the product evidence rather than subject on founder pillars', async () => {
    const s = await capture({ pillarKind: 'founder' });
    expect(s).toMatch(/FOUNDER post/);
    expect(s).toMatch(/product is EVIDENCE, never the subject/);
    expect(s).toMatch(/still works with\s+the product removed/);
  });

  it('keeps product pillars product-led', async () => {
    const s = await capture({ pillarKind: 'product' });
    expect(s).toMatch(/product-domain post/);
    expect(s).not.toMatch(/product is EVIDENCE/);
  });

  it('still injects product facts on founder posts, so they cannot contradict them', async () => {
    const s = await capture({ pillarKind: 'founder' });
    expect(s).toMatch(/EMAIL OUTBOUND ONLY/);
  });

  it('targets the audience the audit named', async () => {
    const s = await capture({
      pillarKind: 'founder',
      primaryAudience: 'Founders, CEOs, and sales leaders at B2B companies',
    });
    expect(s).toMatch(/Founders, CEOs, and sales leaders/);
  });

  it('argues from a belief on file', async () => {
    const s = await capture({
      pillarKind: 'founder',
      beliefs: [
        { label: 'Lists beat copy', belief: 'Targeting decides outcomes, copy only decides margin.', challenges: 'Rewrite your subject lines', evidence: 'Three rebuilds of the same sequence' },
      ],
    });
    expect(s).toMatch(/BELIEFS ON FILE/);
    expect(s).toMatch(/Targeting decides outcomes/);
    expect(s).toMatch(/Pushes against: Rewrite your subject lines/);
  });

  /**
   * The safety property. An invented belief is not the founder's point of view,
   * and company-context forbids fabricated claims.
   */
  it('refuses to invent a belief when none are on file', async () => {
    const s = await capture({ pillarKind: 'founder', beliefs: [] });
    expect(s).toMatch(/NO BELIEFS ARE ON FILE/);
    expect(s).toMatch(/Do not invent one/);
    expect(s).not.toMatch(/BELIEFS ON FILE\./);
  });

  it('closes founder posts on discussion, not a signup ask', async () => {
    const s = await capture({
      pillarKind: 'founder',
      ctaPolicy: { mechanic: 'discussion', productNameInBody: false, destination: 'none' },
    });
    expect(s).toMatch(/inviting disagreement or a counter-example/);
    expect(s).toMatch(/Do not ask for a signup/);
  });
});
