import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, LinkedInError, WritesHaltedError } from '@agent/linkedin-client';
import { runSchedulerTick, type DuePost, type SchedulerDeps } from './scheduler.js';
import type { ScheduleConfig } from '../lib/windows.js';

// 2026-08-17 is a Monday. 13:00Z = 09:00 EDT, inside the window.
const NOW = new Date('2026-08-17T13:00:00Z');

const schedule: ScheduleConfig = {
  timezone: 'America/New_York',
  windows: [{ day: 1, start: '08:30', end: '11:00' }],
  minGapMinutes: 240,
  dailyCap: 2,
  weeklyCap: 7,
  jitterMinutes: 12,
};

function post(id: string): DuePost {
  return { id, accountId: 'a1', body: 'A clean post body.', mediaUrns: [], scheduledAt: null };
}

function deps(overrides: Partial<SchedulerDeps> = {}) {
  const logs: Array<{ stage: string; decision: string; rationale: string }> = [];
  const publishedRows: Array<{ postId: string; urn: string }> = [];
  const failedRows: Array<{ postId: string; reason: string }> = [];
  const rescheduled: Array<{ postId: string; to: Date }> = [];
  const halts: string[] = [];

  const create = vi.fn(async () => ({ urn: 'urn:li:share:7001' }));

  const base: SchedulerDeps = {
    envKillSwitch: false,
    async globalKillSwitchEngaged() { return false; },
    async recentResponses() { return []; },
    failureThreshold: 0.2,
    async raiseHalt(reason) { halts.push(reason); },
    async activeAccounts() {
      return [
        {
          id: 'a1',
          urn: 'urn:li:person:abc123',
          accessToken: 'tok',
          schedule,
          cooldownUntil: null,
        },
      ];
    },
    async duePosts() { return [post('p1')]; },
    async publishedPosts() { return []; },
    posts: { create } as never,
    async markPublished(postId, urn) { publishedRows.push({ postId, urn }); },
    async markFailed(postId, reason) { failedRows.push({ postId, reason }); },
    async reschedule(postId, to) { rescheduled.push({ postId, to }); },
    async log(e) { logs.push({ stage: e.stage, decision: e.decision, rationale: e.rationale }); },
    // No jitter by default so the happy path publishes in the same tick.
    random: () => 0,
    ...overrides,
  };

  return { deps: base, logs, publishedRows, failedRows, rescheduled, halts, create };
}

// --- kill switch: acceptance criterion 7 ------------------------------------

describe('kill switch halts everything within one tick', () => {
  it('aborts on the env var before loading a single account', async () => {
    const h = deps({ envKillSwitch: true });
    const accounts = vi.fn(h.deps.activeAccounts);
    h.deps.activeAccounts = accounts;

    const r = await runSchedulerTick({ now: NOW, deps: h.deps });

    expect(r.halted).toBe(true);
    expect(r.haltReason).toMatch(/AGENT_KILL_SWITCH/);
    expect(r.published).toBe(0);
    // The proof that it halts *immediately*: nothing downstream was even asked.
    expect(accounts).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('aborts on the dashboard switch before loading a single account', async () => {
    const h = deps({ async globalKillSwitchEngaged() { return true; } });
    const accounts = vi.fn(h.deps.activeAccounts);
    h.deps.activeAccounts = accounts;

    const r = await runSchedulerTick({ now: NOW, deps: h.deps });

    expect(r.halted).toBe(true);
    expect(r.haltReason).toMatch(/dashboard/);
    expect(accounts).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('logs the abort so the digest can report it', async () => {
    const h = deps({ envKillSwitch: true });
    await runSchedulerTick({ now: NOW, deps: h.deps });
    expect(h.logs).toContainEqual(
      expect.objectContaining({ stage: 'halt', decision: 'tick aborted' }),
    );
  });

  it('publishes normally when neither switch is set', async () => {
    const h = deps();
    const r = await runSchedulerTick({ now: NOW, deps: h.deps });
    expect(r).toMatchObject({ halted: false, published: 1, failed: 0 });
    expect(h.publishedRows).toEqual([{ postId: 'p1', urn: 'urn:li:share:7001' }]);
  });
});

// --- anomaly halt -----------------------------------------------------------

describe('anomaly halt', () => {
  it('aborts the tick on a 401 and never calls publish', async () => {
    const h = deps({
      async recentResponses() {
        return [{ code: 401, isWrite: true }];
      },
    });
    const r = await runSchedulerTick({ now: NOW, deps: h.deps });

    expect(r.halted).toBe(true);
    expect(r.haltReason).toMatch(/Token or scope is gone/);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.halts).toHaveLength(1);
  });

  it('aborts above the failure threshold', async () => {
    const h = deps({
      async recentResponses() {
        return [
          { code: 500, isWrite: true },
          { code: 500, isWrite: true },
          { code: 201, isWrite: true },
        ];
      },
    });
    const r = await runSchedulerTick({ now: NOW, deps: h.deps });
    expect(r.halted).toBe(true);
    expect(h.create).not.toHaveBeenCalled();
  });
});

// --- window and pacing integration ------------------------------------------

describe('pacing', () => {
  it('defers a post outside the window instead of failing it', async () => {
    const h = deps();
    const threeAm = new Date('2026-08-17T07:00:00Z');
    const r = await runSchedulerTick({ now: threeAm, deps: h.deps });

    expect(r).toMatchObject({ published: 0, failed: 0, skipped: 1 });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.failedRows).toEqual([]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        decision: 'deferred',
        rationale: expect.stringContaining('Outside every configured publishing window'),
      }),
    );
  });

  it('publishes a human-scheduled post when due even outside the cadence window', async () => {
    const threeAm = new Date('2026-08-17T07:00:00Z');
    const h = deps({
      async duePosts() { return [{ ...post('p1'), scheduledAt: threeAm }]; },
    });
    const r = await runSchedulerTick({ now: threeAm, deps: h.deps });

    expect(r).toMatchObject({ published: 1, failed: 0 });
    expect(h.create).toHaveBeenCalledOnce();
  });

  it('honors Post now even when automatic cadence caps and spacing are full', async () => {
    const h = deps({
      async duePosts() { return [{ ...post('p1'), scheduledAt: NOW }]; },
      async publishedPosts() { return [{ publishedAt: new Date(NOW.getTime() - 60_000) }]; },
    });
    const r = await runSchedulerTick({ now: NOW, deps: h.deps });

    expect(r).toMatchObject({ published: 1, skipped: 0 });
    expect(h.create).toHaveBeenCalledOnce();
  });

  it('parks a jittered post for a later tick rather than sleeping', async () => {
    const h = deps({ random: () => 0.99 });
    const r = await runSchedulerTick({ now: NOW, deps: h.deps });

    expect(r.published).toBe(0);
    expect(r.skipped).toBe(1);
    expect(h.rescheduled).toHaveLength(1);
    expect(h.rescheduled[0]?.to.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('counts a post published this tick against later posts in the same tick', async () => {
    const h = deps({
      async duePosts() { return [post('p1'), post('p2'), post('p3')]; },
    });
    const r = await runSchedulerTick({ now: NOW, deps: h.deps });

    // Only one publishes. The minimum gap (240m) dominates the daily cap (2):
    // once p1 goes out, p2 and p3 are inside the spacing window and defer.
    // This is the pacing rule doing its job — a tick can never burst.
    expect(r.published).toBe(1);
    expect(r.skipped).toBe(2);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        decision: 'deferred',
        rationale: expect.stringContaining('minimum gap is 240m'),
      }),
    );
  });

  it('never bursts even when the daily cap would allow it', async () => {
    // Cap of 5, but the gap is still 240m. Spacing is the binding constraint.
    const h = deps({
      async activeAccounts() {
        return [
          {
            id: 'a1',
            urn: 'urn:li:person:abc123',
            accessToken: 'tok',
            schedule: { ...schedule, dailyCap: 5 },
            cooldownUntil: null,
          },
        ];
      },
      async duePosts() { return [post('p1'), post('p2'), post('p3'), post('p4')]; },
    });
    const r = await runSchedulerTick({ now: NOW, deps: h.deps });
    expect(r.published).toBe(1);
  });
});

// --- error handling ---------------------------------------------------------

describe('publish failures', () => {
  it('marks a post failed on a transient error and keeps going', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new LinkedInError('boom', { status: 500, endpoint: '/posts' }),
      )
      .mockResolvedValueOnce({ urn: 'urn:li:share:7002' });

    const h = deps({
      posts: { create } as never,
      async duePosts() { return [post('p1'), post('p2')]; },
      async publishedPosts() { return []; },
    });

    const r = await runSchedulerTick({ now: NOW, deps: h.deps });
    expect(r.failed).toBe(1);
    expect(r.published).toBe(1);
    expect(h.failedRows[0]?.reason).toMatch(/500/);
  });

  it('halts the whole tick on a fatal error rather than failing post by post', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(new LinkedInError('revoked', { status: 401, endpoint: '/posts' }));

    const h = deps({
      posts: { create } as never,
      async duePosts() { return [post('p1'), post('p2'), post('p3')]; },
    });

    const r = await runSchedulerTick({ now: NOW, deps: h.deps });
    expect(r.halted).toBe(true);
    expect(r.failed).toBe(1);
    // Stopped after the first, rather than burning quota on two more certainties.
    expect(create).toHaveBeenCalledTimes(1);
    expect(h.halts).toHaveLength(1);
  });

  it.each([
    ['budget', new BudgetExceededError('a1', 80, 80)],
    ['halt', new WritesHaltedError('paused')],
  ])('treats a %s block as skipped, not failed', async (_label, error) => {
    const create = vi.fn().mockRejectedValue(error);
    const h = deps({
      posts: { create } as never,
      async duePosts() { return [post('p1'), post('p2')]; },
    });

    const r = await runSchedulerTick({ now: NOW, deps: h.deps });
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(1);
    expect(h.failedRows).toEqual([]);
    // Both brakes are account-wide, so the loop breaks instead of retrying p2.
    expect(create).toHaveBeenCalledTimes(1);
  });
});
