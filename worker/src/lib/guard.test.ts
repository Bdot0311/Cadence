import { describe, expect, it } from 'vitest';
import { BudgetExceededError, WritesHaltedError } from '@agent/linkedin-client';
import { SupabaseWriteGuard, shouldHalt, type GuardConfig, type GuardStore } from './guard.js';

const NOW = new Date('2026-08-15T14:00:00Z');

function store(overrides: Partial<GuardStore> = {}): GuardStore & {
  pauses: Array<{ until: Date; reason: string }>;
} {
  const pauses: Array<{ until: Date; reason: string }> = [];
  return {
    pauses,
    async writesToday() { return 0; },
    async rateLimitHitsInLastHour() { return 0; },
    async pausedUntil() { return null; },
    async pauseAccount(_id, until, reason) { pauses.push({ until, reason }); },
    async killSwitchEngaged() { return false; },
    async dryRunUntil() { return null; },
    async insertLedgerRow() {},
    ...overrides,
  };
}

const cfg: GuardConfig = {
  envKillSwitch: false,
  envDryRun: false,
  dailyWriteBudget: 80,
  rateLimitTripsBeforePause: 2,
};

const guard = (s: GuardStore, c: Partial<GuardConfig> = {}) =>
  new SupabaseWriteGuard(s, { ...cfg, ...c }, () => NOW);

// --- kill switch (acceptance criterion 7) -----------------------------------

describe('kill switch', () => {
  it('halts on the env var', async () => {
    await expect(
      guard(store(), { envKillSwitch: true }).assertCanWrite('a1'),
    ).rejects.toThrow(/AGENT_KILL_SWITCH/);
  });

  it('halts on the dashboard button independently of the env var', async () => {
    const s = store({ async killSwitchEngaged() { return true; } });
    await expect(guard(s).assertCanWrite('a1')).rejects.toThrow(/dashboard/);
  });

  it('is checked before the budget, so an exhausted account still reports the halt', async () => {
    const s = store({ async writesToday() { return 999; } });
    const err = await guard(s, { envKillSwitch: true })
      .assertCanWrite('a1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WritesHaltedError);
  });
});

// --- dry run ----------------------------------------------------------------

describe('dry run', () => {
  it('halts on the env var', async () => {
    await expect(guard(store(), { envDryRun: true }).assertCanWrite('a1')).rejects.toThrow(
      /nothing published/,
    );
  });

  it('halts inside the post-install window even when the env var is off', async () => {
    const s = store({ async dryRunUntil() { return new Date('2026-08-20T00:00:00Z'); } });
    await expect(guard(s).assertCanWrite('a1')).rejects.toThrow(/post-install dry-run/);
  });

  it('permits writes once the window has passed', async () => {
    const s = store({ async dryRunUntil() { return new Date('2026-08-01T00:00:00Z'); } });
    await expect(guard(s).assertCanWrite('a1')).resolves.toBeUndefined();
  });
});

// --- budget -----------------------------------------------------------------

describe('daily write budget', () => {
  it('permits a write under budget', async () => {
    const s = store({ async writesToday() { return 79; } });
    await expect(guard(s).assertCanWrite('a1')).resolves.toBeUndefined();
  });

  it('blocks at the budget, below LinkedIn\'s own ceiling', async () => {
    const s = store({ async writesToday() { return 80; } });
    const err = await guard(s).assertCanWrite('a1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).budget).toBe(80);
  });
});

// --- account pause (acceptance criterion 4) ---------------------------------

describe('rate-limit pause', () => {
  it('does not pause on the first trip in an hour', async () => {
    const s = store({ async rateLimitHitsInLastHour() { return 0; } });
    await guard(s).onRateLimited('a1', quota());
    expect(s.pauses).toEqual([]);
  });

  it('pauses for the rest of the day on the second trip in an hour', async () => {
    const s = store({ async rateLimitHitsInLastHour() { return 1; } });
    await guard(s).onRateLimited('a1', quota({ remaining: 0 }));

    expect(s.pauses).toHaveLength(1);
    expect(s.pauses[0]?.until.toISOString()).toBe('2026-08-15T23:59:59.999Z');
    expect(s.pauses[0]?.reason).toMatch(/Rate limited 2 times/);
    expect(s.pauses[0]?.reason).toMatch(/quota remaining: 0/);
  });

  it('refuses writes while paused', async () => {
    const s = store({ async pausedUntil() { return new Date('2026-08-15T23:59:59Z'); } });
    await expect(guard(s).assertCanWrite('a1')).rejects.toThrow(/paused until/);
  });

  it('resumes writes once the pause has lapsed', async () => {
    const s = store({ async pausedUntil() { return new Date('2026-08-15T13:00:00Z'); } });
    await expect(guard(s).assertCanWrite('a1')).resolves.toBeUndefined();
  });

  function quota(o: Partial<{ remaining: number }> = {}) {
    return {
      remaining: o.remaining ?? null,
      limit: null,
      resetAt: null,
      retryAfterSeconds: null,
    };
  }
});

// --- anomaly halt -----------------------------------------------------------

describe('shouldHalt', () => {
  it('halts immediately on a 401', () => {
    const r = shouldHalt({
      recentResponses: [{ code: 200, isWrite: true }, { code: 401, isWrite: true }],
      failureThreshold: 0.2,
    });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/Token or scope is gone/);
  });

  it('halts immediately on a 403 even at a healthy failure rate', () => {
    const responses = Array.from({ length: 20 }, () => ({ code: 200, isWrite: true }));
    responses.push({ code: 403, isWrite: true });
    expect(shouldHalt({ recentResponses: responses, failureThreshold: 0.2 }).halt).toBe(true);
  });

  it('halts above the failure-rate threshold', () => {
    const r = shouldHalt({
      recentResponses: [
        { code: 500, isWrite: true },
        { code: 500, isWrite: true },
        { code: 201, isWrite: true },
        { code: 201, isWrite: true },
      ],
      failureThreshold: 0.2,
    });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/50%/);
  });

  it('does not halt at exactly the threshold', () => {
    const r = shouldHalt({
      recentResponses: [
        { code: 500, isWrite: true },
        { code: 201, isWrite: true },
        { code: 201, isWrite: true },
        { code: 201, isWrite: true },
        { code: 201, isWrite: true },
      ],
      failureThreshold: 0.2,
    });
    expect(r.halt).toBe(false);
  });

  it('ignores read failures when computing the publish failure rate', () => {
    const r = shouldHalt({
      recentResponses: [
        { code: 500, isWrite: false },
        { code: 500, isWrite: false },
        { code: 201, isWrite: true },
      ],
      failureThreshold: 0.2,
    });
    expect(r.halt).toBe(false);
  });

  it('does not halt when there were no writes at all', () => {
    expect(
      shouldHalt({ recentResponses: [{ code: 200, isWrite: false }], failureThreshold: 0.2 }).halt,
    ).toBe(false);
  });

  it('counts a network failure (null code) as a failure', () => {
    const r = shouldHalt({
      recentResponses: [
        { code: null, isWrite: true },
        { code: 201, isWrite: true },
      ],
      failureThreshold: 0.2,
    });
    expect(r.halt).toBe(true);
  });
});
