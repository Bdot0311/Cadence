/**
 * Candidate selection.
 *
 * Ideation deliberately overproduces (~3x what will ship) so this step has
 * something to select from. Selection is where the strategy actually gets
 * enforced: pillar mix, topic recency, and structural variety.
 *
 * Pure functions. The caller supplies the clock and the history.
 */

export interface Candidate {
  id: string;
  angle: string;
  pillarId: string;
  /** Lowercased keyword set for topic-overlap scoring. */
  topicTokens: string[];
  /** Predicted shape, from the ideation step. Compared against recent posts. */
  structureHash?: string | null;
}

export interface Pillar {
  id: string;
  name: string;
  /** Desired share of output, 0..1. */
  targetShare: number;
}

export interface RecentPost {
  pillarId: string;
  publishedAt: Date;
  topicTokens: string[];
  structureHash: string | null;
}

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  /** Human-readable, written to agent_log so a pick is explainable later. */
  rationale: string;
  blocked: string | null;
}

/** Two structurally similar posts may not ship inside this many days. */
export const STRUCTURE_BLOCK_DAYS = 10;
/** Topic overlap above this fraction inside the window is treated as a repeat. */
export const TOPIC_OVERLAP_THRESHOLD = 0.5;

/**
 * Observed share of each pillar across recent posts. Uses the trailing window
 * rather than all history so a strategy change takes effect in weeks, not
 * never.
 */
export function observedMix(
  posts: RecentPost[],
  pillars: Pillar[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of pillars) counts.set(p.id, 0);
  for (const post of posts) {
    counts.set(post.pillarId, (counts.get(post.pillarId) ?? 0) + 1);
  }
  const total = posts.length;
  const mix = new Map<string, number>();
  for (const p of pillars) {
    mix.set(p.id, total === 0 ? 0 : (counts.get(p.id) ?? 0) / total);
  }
  return mix;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a.map((t) => t.toLowerCase()));
  const sb = new Set(b.map((t) => t.toLowerCase()));
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.size + sb.size - shared);
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * Score one candidate.
 *
 * Positive score means "ship this next". The dominant term is pillar debt: how
 * far below its target share a pillar currently sits. That is what keeps the
 * feed on strategy instead of drifting toward whatever the model finds easiest
 * to write about.
 */
export function scoreCandidate(args: {
  candidate: Candidate;
  pillars: Pillar[];
  recent: RecentPost[];
  now: Date;
}): ScoredCandidate {
  const { candidate, pillars, recent, now } = args;
  const pillar = pillars.find((p) => p.id === candidate.pillarId);

  if (!pillar) {
    return {
      candidate,
      score: -Infinity,
      rationale: 'Candidate references a pillar that no longer exists.',
      blocked: 'unknown-pillar',
    };
  }

  const inWindow = recent.filter((p) => daysBetween(p.publishedAt, now) <= STRUCTURE_BLOCK_DAYS);

  // Hard block 1: structural repetition. A feed of same-shaped posts reads as
  // machine output no matter how varied the subjects are.
  if (candidate.structureHash) {
    const clash = inWindow.find((p) => p.structureHash === candidate.structureHash);
    if (clash) {
      return {
        candidate,
        score: -Infinity,
        rationale: `Same structure as a post from ${Math.floor(daysBetween(clash.publishedAt, now))} days ago; block window is ${STRUCTURE_BLOCK_DAYS} days.`,
        blocked: 'structure-repeat',
      };
    }
  }

  // Hard block 2: topic repetition inside the same window.
  const overlaps = inWindow
    .map((p) => ({ post: p, overlap: jaccard(candidate.topicTokens, p.topicTokens) }))
    .filter((x) => x.overlap >= TOPIC_OVERLAP_THRESHOLD)
    .sort((a, b) => b.overlap - a.overlap);

  const worst = overlaps[0];
  if (worst) {
    return {
      candidate,
      score: -Infinity,
      rationale: `${Math.round(worst.overlap * 100)}% topic overlap with a post from ${Math.floor(daysBetween(worst.post.publishedAt, now))} days ago.`,
      blocked: 'topic-repeat',
    };
  }

  // Pillar debt: target share minus observed share. Positive means underserved.
  const mix = observedMix(inWindow, pillars);
  const debt = pillar.targetShare - (mix.get(pillar.id) ?? 0);

  // Recency of this pillar specifically. A pillar untouched for a while gets a
  // nudge even when its overall share looks fine.
  const lastForPillar = inWindow
    .filter((p) => p.pillarId === pillar.id)
    .reduce<Date | null>((acc, p) => (acc === null || p.publishedAt > acc ? p.publishedAt : acc), null);
  const daysSincePillar = lastForPillar === null ? STRUCTURE_BLOCK_DAYS : daysBetween(lastForPillar, now);
  const recencyBonus = Math.min(daysSincePillar / STRUCTURE_BLOCK_DAYS, 1) * 0.2;

  const score = debt + recencyBonus;

  return {
    candidate,
    score,
    rationale:
      `Pillar "${pillar.name}" is at ${((mix.get(pillar.id) ?? 0) * 100).toFixed(0)}% ` +
      `against a ${(pillar.targetShare * 100).toFixed(0)}% target (debt ${debt.toFixed(2)}), ` +
      `last used ${lastForPillar === null ? 'never in window' : `${Math.floor(daysSincePillar)}d ago`}.`,
    blocked: null,
  };
}

/**
 * Rank candidates and take the top N.
 *
 * Returns every candidate scored, not just the winners, so `agent_log` can
 * record what was considered and why it lost. A selection you cannot explain
 * later is one you cannot debug.
 */
export function selectCandidates(args: {
  candidates: Candidate[];
  pillars: Pillar[];
  recent: RecentPost[];
  now: Date;
  take: number;
}): { selected: ScoredCandidate[]; rejected: ScoredCandidate[] } {
  const scored = args.candidates.map((candidate) =>
    scoreCandidate({ candidate, pillars: args.pillars, recent: args.recent, now: args.now }),
  );

  const eligible = scored
    .filter((s) => s.blocked === null)
    .sort((a, b) => b.score - a.score);

  const selected: ScoredCandidate[] = [];
  // Track picks as they are made so two candidates from the same pillar don't
  // both win on the same debt figure.
  const simulated: RecentPost[] = [...args.recent];

  for (const s of eligible) {
    if (selected.length >= args.take) break;

    const rescored = scoreCandidate({
      candidate: s.candidate,
      pillars: args.pillars,
      recent: simulated,
      now: args.now,
    });
    if (rescored.blocked !== null) continue;

    selected.push(rescored);
    simulated.push({
      pillarId: s.candidate.pillarId,
      publishedAt: args.now,
      topicTokens: s.candidate.topicTokens,
      structureHash: s.candidate.structureHash ?? null,
    });
  }

  const selectedIds = new Set(selected.map((s) => s.candidate.id));
  return { selected, rejected: scored.filter((s) => !selectedIds.has(s.candidate.id)) };
}

/**
 * Weekly pillar-mix adjustment from performance.
 *
 * Capped at ±`maxDelta` absolute change per pillar per week so one viral
 * outlier cannot reshape the whole strategy. Result is renormalised to sum to
 * 1, because a set of shares that doesn't is a silent bug in every downstream
 * debt calculation.
 */
export function adjustPillarMix(args: {
  pillars: Pillar[];
  /** Mean engagement rate per pillar over the measurement window. */
  performanceByPillar: Map<string, number>;
  maxDelta?: number;
}): Map<string, number> {
  const maxDelta = args.maxDelta ?? 0.15;
  const perf = args.performanceByPillar;

  const measured = args.pillars.filter((p) => perf.has(p.id));
  if (measured.length === 0) {
    return new Map(args.pillars.map((p) => [p.id, p.targetShare]));
  }

  const mean =
    measured.reduce((sum, p) => sum + (perf.get(p.id) ?? 0), 0) / measured.length;
  if (mean === 0) {
    return new Map(args.pillars.map((p) => [p.id, p.targetShare]));
  }

  // Work in DELTAS rather than absolute shares, and keep them zero-sum.
  //
  // The naive version — clamp each share, then normalise to sum to 1 — does not
  // respect the cap: normalisation rescales every share, so a pillar clamped to
  // +0.15 can land at +0.21 once the others shrink. Targets already sum to 1,
  // so if the deltas sum to 0 the result sums to 1 with no normalisation, and
  // the cap survives.
  const clampDelta = (pillar: Pillar, d: number): number => {
    // Never move more than maxDelta, and never drive a share below zero.
    const floor = Math.max(-maxDelta, -pillar.targetShare);
    return Math.max(floor, Math.min(maxDelta, d));
  };

  // Clamp BEFORE the convergence loop. The raw relative deltas can already sum
  // to zero while individually blowing past the cap, and a loop that checks the
  // sum first would exit without ever clamping them.
  let deltas = new Map<string, number>(
    args.pillars.map((p) => {
      const observed = perf.get(p.id);
      const raw = observed === undefined ? 0 : ((observed - mean) / mean) * maxDelta;
      return [p.id, clampDelta(p, raw)];
    }),
  );

  // Alternate zero-summing and clamping. Zero-summing can push a delta back out
  // of range and clamping can break the zero-sum, so iterate to a fixed point.
  // Converges in a handful of passes for any realistic pillar count.
  for (let pass = 0; pass < 20; pass++) {
    const sum = [...deltas.values()].reduce((a, b) => a + b, 0);
    if (Math.abs(sum) < 1e-12) break;

    // Spread the residual only across pillars that still have headroom;
    // pushing it into a clamped pillar would just be re-clamped next pass.
    const free = args.pillars.filter((p) => {
      const d = deltas.get(p.id) ?? 0;
      const floor = Math.max(-maxDelta, -p.targetShare);
      return d > floor + 1e-12 && d < maxDelta - 1e-12;
    });
    const spreadAcross = free.length > 0 ? free : args.pillars;
    const correction = sum / spreadAcross.length;

    const next = new Map(deltas);
    for (const p of spreadAcross) {
      next.set(p.id, (next.get(p.id) ?? 0) - correction);
    }
    for (const p of args.pillars) {
      next.set(p.id, clampDelta(p, next.get(p.id) ?? 0));
    }
    deltas = next;
  }

  return new Map(
    args.pillars.map((p) => [p.id, Math.max(0, p.targetShare + (deltas.get(p.id) ?? 0))]),
  );
}
