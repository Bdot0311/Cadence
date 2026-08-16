import { describe, expect, it } from 'vitest';
import {
  STRUCTURE_BLOCK_DAYS,
  adjustPillarMix,
  observedMix,
  scoreCandidate,
  selectCandidates,
  type Candidate,
  type Pillar,
  type RecentPost,
} from './selection.js';

const NOW = new Date('2026-08-17T13:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const pillars: Pillar[] = [
  { id: 'craft', name: 'Outbound craft', targetShare: 0.5 },
  { id: 'build', name: 'Building in public', targetShare: 0.3 },
  { id: 'ops', name: 'Solo founder ops', targetShare: 0.2 },
];

function candidate(o: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c1',
    angle: 'Why list quality beats copy quality',
    pillarId: 'craft',
    topicTokens: ['list', 'targeting', 'quality'],
    structureHash: 'aaaa1111',
    ...o,
  };
}

function recent(o: Partial<RecentPost> = {}): RecentPost {
  return {
    pillarId: 'craft',
    publishedAt: daysAgo(3),
    topicTokens: ['copy', 'subject', 'lines'],
    structureHash: 'bbbb2222',
    ...o,
  };
}

describe('observedMix', () => {
  it('returns zero shares when nothing has published', () => {
    const mix = observedMix([], pillars);
    expect([...mix.values()]).toEqual([0, 0, 0]);
  });

  it('computes share per pillar', () => {
    const posts = [recent(), recent(), recent({ pillarId: 'build' })];
    const mix = observedMix(posts, pillars);
    expect(mix.get('craft')).toBeCloseTo(2 / 3);
    expect(mix.get('build')).toBeCloseTo(1 / 3);
    expect(mix.get('ops')).toBe(0);
  });
});

describe('structural repetition block', () => {
  it('blocks a candidate sharing a structure hash inside the window', () => {
    const s = scoreCandidate({
      candidate: candidate({ structureHash: 'dupe' }),
      pillars,
      recent: [recent({ structureHash: 'dupe', publishedAt: daysAgo(9) })],
      now: NOW,
    });
    expect(s.blocked).toBe('structure-repeat');
    expect(s.score).toBe(-Infinity);
    expect(s.rationale).toMatch(/Same structure as a post from 9 days ago/);
  });

  it('allows the same structure once the window has passed', () => {
    const s = scoreCandidate({
      candidate: candidate({ structureHash: 'dupe' }),
      pillars,
      recent: [recent({ structureHash: 'dupe', publishedAt: daysAgo(STRUCTURE_BLOCK_DAYS + 1) })],
      now: NOW,
    });
    expect(s.blocked).toBeNull();
  });
});

describe('topic repetition block', () => {
  it('blocks a candidate overlapping heavily with a recent post', () => {
    const s = scoreCandidate({
      candidate: candidate({ topicTokens: ['deliverability', 'spam', 'inbox'] }),
      pillars,
      recent: [recent({ topicTokens: ['deliverability', 'spam', 'inbox'], structureHash: 'x' })],
      now: NOW,
    });
    expect(s.blocked).toBe('topic-repeat');
    expect(s.rationale).toMatch(/100% topic overlap/);
  });

  it('allows a distinct topic in the same pillar', () => {
    const s = scoreCandidate({
      candidate: candidate({ topicTokens: ['pricing', 'packaging'] }),
      pillars,
      recent: [recent({ topicTokens: ['deliverability', 'spam'], structureHash: 'x' })],
      now: NOW,
    });
    expect(s.blocked).toBeNull();
  });
});

describe('pillar debt scoring', () => {
  it('favours the most underserved pillar', () => {
    // craft is over-represented, ops has published nothing.
    const history = [
      recent({ pillarId: 'craft', structureHash: 'h1', topicTokens: ['a'] }),
      recent({ pillarId: 'craft', structureHash: 'h2', topicTokens: ['b'] }),
      recent({ pillarId: 'craft', structureHash: 'h3', topicTokens: ['c'] }),
    ];

    const craft = scoreCandidate({
      candidate: candidate({ pillarId: 'craft', topicTokens: ['z'], structureHash: 'new1' }),
      pillars,
      recent: history,
      now: NOW,
    });
    const ops = scoreCandidate({
      candidate: candidate({ pillarId: 'ops', topicTokens: ['z'], structureHash: 'new2' }),
      pillars,
      recent: history,
      now: NOW,
    });

    expect(ops.score).toBeGreaterThan(craft.score);
    // craft is at 100% against a 50% target, so its debt is negative.
    expect(craft.score).toBeLessThan(0);
  });

  it('explains itself for the decision log', () => {
    const s = scoreCandidate({ candidate: candidate(), pillars, recent: [], now: NOW });
    expect(s.rationale).toMatch(/Pillar "Outbound craft" is at 0% against a 50% target/);
  });

  it('rejects a candidate whose pillar was deleted', () => {
    const s = scoreCandidate({
      candidate: candidate({ pillarId: 'gone' }),
      pillars,
      recent: [],
      now: NOW,
    });
    expect(s.blocked).toBe('unknown-pillar');
  });
});

describe('selectCandidates', () => {
  it('takes the requested number and returns the rest as rejected', () => {
    const candidates = [
      candidate({ id: 'a', pillarId: 'craft', topicTokens: ['q'], structureHash: 's1' }),
      candidate({ id: 'b', pillarId: 'build', topicTokens: ['r'], structureHash: 's2' }),
      candidate({ id: 'c', pillarId: 'ops', topicTokens: ['t'], structureHash: 's3' }),
    ];
    const { selected, rejected } = selectCandidates({
      candidates,
      pillars,
      recent: [],
      now: NOW,
      take: 2,
    });
    expect(selected).toHaveLength(2);
    expect(rejected).toHaveLength(1);
  });

  it('does not pick two candidates that would collide with each other', () => {
    // Same structure hash: the second must not be picked just because the
    // first had not published yet when scoring began.
    const candidates = [
      candidate({ id: 'a', pillarId: 'craft', topicTokens: ['q'], structureHash: 'same' }),
      candidate({ id: 'b', pillarId: 'build', topicTokens: ['r'], structureHash: 'same' }),
    ];
    const { selected } = selectCandidates({
      candidates,
      pillars,
      recent: [],
      now: NOW,
      take: 2,
    });
    expect(selected).toHaveLength(1);
  });

  it('does not pick two candidates covering the same topic', () => {
    const candidates = [
      candidate({ id: 'a', pillarId: 'craft', topicTokens: ['icp', 'scoring'], structureHash: 's1' }),
      candidate({ id: 'b', pillarId: 'build', topicTokens: ['icp', 'scoring'], structureHash: 's2' }),
    ];
    const { selected } = selectCandidates({
      candidates,
      pillars,
      recent: [],
      now: NOW,
      take: 2,
    });
    expect(selected).toHaveLength(1);
  });

  it('returns nothing when every candidate is blocked', () => {
    const { selected, rejected } = selectCandidates({
      candidates: [candidate({ structureHash: 'dupe' })],
      pillars,
      recent: [recent({ structureHash: 'dupe' })],
      now: NOW,
      take: 3,
    });
    expect(selected).toEqual([]);
    expect(rejected).toHaveLength(1);
  });
});

describe('adjustPillarMix', () => {
  const perf = (m: Record<string, number>) => new Map(Object.entries(m));

  it('leaves the mix alone when there is no performance data', () => {
    const out = adjustPillarMix({ pillars, performanceByPillar: new Map() });
    expect(out.get('craft')).toBe(0.5);
    expect(out.get('ops')).toBe(0.2);
  });

  it('shifts share toward the better-performing pillar', () => {
    const out = adjustPillarMix({
      pillars,
      performanceByPillar: perf({ craft: 0.01, build: 0.05, ops: 0.01 }),
    });
    expect(out.get('build')!).toBeGreaterThan(0.3);
    expect(out.get('craft')!).toBeLessThan(0.5);
  });

  it('caps movement so one viral outlier cannot reshape the strategy', () => {
    const out = adjustPillarMix({
      pillars,
      // ops at 100x the others.
      performanceByPillar: perf({ craft: 0.001, build: 0.001, ops: 0.1 }),
      maxDelta: 0.15,
    });
    // The cap is absolute and survives to the returned shares. An earlier
    // version clamped before normalising, which let this land at +0.21.
    for (const p of pillars) {
      expect(Math.abs(out.get(p.id)! - p.targetShare), p.id).toBeLessThanOrEqual(0.15 + 1e-9);
    }
    expect(out.get('ops')!).toBeGreaterThan(0.2);
  });

  it('respects the cap across a spread of performance shapes', () => {
    const shapes = [
      { craft: 0.1, build: 0.001, ops: 0.001 },
      { craft: 0.001, build: 0.1, ops: 0.001 },
      { craft: 0.05, build: 0.05, ops: 0.0001 },
      { craft: 1, build: 0.5, ops: 0.25 },
    ];
    for (const shape of shapes) {
      const out = adjustPillarMix({ pillars, performanceByPillar: perf(shape) });
      const total = [...out.values()].reduce((a, b) => a + b, 0);
      expect(total, JSON.stringify(shape)).toBeCloseTo(1, 9);
      for (const p of pillars) {
        expect(
          Math.abs(out.get(p.id)! - p.targetShare),
          `${p.id} @ ${JSON.stringify(shape)}`,
        ).toBeLessThanOrEqual(0.15 + 1e-9);
      }
    }
  });

  it('always returns shares summing to 1', () => {
    const out = adjustPillarMix({
      pillars,
      performanceByPillar: perf({ craft: 0.08, build: 0.02, ops: 0.03 }),
    });
    const total = [...out.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('never produces a negative share', () => {
    const out = adjustPillarMix({
      pillars: [{ id: 'tiny', name: 'Tiny', targetShare: 0.02 }, ...pillars],
      performanceByPillar: perf({ tiny: 0.0001, craft: 0.09, build: 0.09, ops: 0.09 }),
    });
    for (const v of out.values()) expect(v).toBeGreaterThanOrEqual(0);
  });
});
