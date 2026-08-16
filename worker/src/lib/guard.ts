import {
  BudgetExceededError,
  WritesHaltedError,
  type LedgerEntry,
  type LedgerSink,
  type QuotaSnapshot,
  type WriteGuard,
} from '@agent/linkedin-client';

/**
 * The write guard: everything that can stop a post from going out, checked
 * before the request is built.
 *
 * Four independent brakes, any one of which halts a write:
 *   1. Kill switch (env var OR dashboard button)
 *   2. Dry-run mode (env var OR the 7-day post-install window)
 *   3. Daily write budget, read from the ledger
 *   4. Account pause, set when rate limits trip twice in an hour
 *
 * They are deliberately independent. A single `enabled` flag would be one
 * accidental UPDATE away from publishing during an incident.
 */

export interface GuardStore {
  /** Writes counted against today's budget for this account. */
  writesToday(accountId: string): Promise<number>;
  /** Rate-limit responses (429/503) for this account in the trailing hour. */
  rateLimitHitsInLastHour(accountId: string): Promise<number>;
  /** Null when the account is not paused. */
  pausedUntil(accountId: string): Promise<Date | null>;
  pauseAccount(accountId: string, until: Date, reason: string): Promise<void>;
  /** Dashboard-side kill switch, stored on agent_config. */
  killSwitchEngaged(accountId: string): Promise<boolean>;
  /** agent_config.dry_run_until — the 7-day post-install window. */
  dryRunUntil(accountId: string): Promise<Date | null>;
  insertLedgerRow(entry: LedgerEntry): Promise<void>;
}

export interface GuardConfig {
  /** AGENT_KILL_SWITCH. Env-level, independent of the dashboard button. */
  envKillSwitch: boolean;
  /** AGENT_DRY_RUN. */
  envDryRun: boolean;
  /** DAILY_WRITE_BUDGET. Deliberately below LinkedIn's ~100/day/member. */
  dailyWriteBudget: number;
  /** Rate-limit trips in an hour before the account is paused for the day. */
  rateLimitTripsBeforePause: number;
}

export class SupabaseWriteGuard implements WriteGuard, LedgerSink {
  constructor(
    private readonly store: GuardStore,
    private readonly cfg: GuardConfig,
    /** Injectable for tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async assertCanWrite(accountId: string): Promise<void> {
    // 1. Kill switch. Env first — it's the one that works when the database is
    // the thing that's broken.
    if (this.cfg.envKillSwitch) {
      throw new WritesHaltedError('AGENT_KILL_SWITCH is set');
    }
    if (await this.store.killSwitchEngaged(accountId)) {
      throw new WritesHaltedError('kill switch engaged from the dashboard');
    }

    // 2. Dry run. Whichever of the two is more restrictive wins, so an env var
    // cannot shorten the 7-day post-install window.
    if (this.cfg.envDryRun) {
      throw new WritesHaltedError('AGENT_DRY_RUN is set: pipeline ran, nothing published');
    }
    const dryUntil = await this.store.dryRunUntil(accountId);
    if (dryUntil && this.now() < dryUntil) {
      throw new WritesHaltedError(
        `still inside the post-install dry-run window (until ${dryUntil.toISOString()})`,
      );
    }

    // 3. Account pause from a rate-limit trip.
    const paused = await this.store.pausedUntil(accountId);
    if (paused && this.now() < paused) {
      throw new WritesHaltedError(
        `account paused until ${paused.toISOString()} after repeated rate limiting`,
      );
    }

    // 4. Daily budget. Budgeted below LinkedIn's ceiling on purpose: we block
    // at our number, not by discovering theirs.
    const used = await this.store.writesToday(accountId);
    if (used >= this.cfg.dailyWriteBudget) {
      throw new BudgetExceededError(accountId, used, this.cfg.dailyWriteBudget);
    }
  }

  /**
   * Called by the client after a 429 or 503.
   *
   * Two trips in a rolling hour pauses the account for the rest of the local
   * day. One trip is noise — a retry handles it. Two means we are
   * systematically over some limit we cannot see, and continuing to probe it is
   * how a temporary throttle becomes a lasting one.
   */
  async onRateLimited(accountId: string, quota: QuotaSnapshot): Promise<void> {
    const hits = await this.store.rateLimitHitsInLastHour(accountId);
    if (hits + 1 < this.cfg.rateLimitTripsBeforePause) return;

    const until = endOfUtcDay(this.now());
    await this.store.pauseAccount(
      accountId,
      until,
      `Rate limited ${hits + 1} times within an hour` +
        (quota.remaining === null ? '' : ` (quota remaining: ${quota.remaining})`),
    );
  }

  async record(entry: LedgerEntry): Promise<void> {
    await this.store.insertLedgerRow(entry);
  }
}

function endOfUtcDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/**
 * Anomaly halt. Distinct from the per-account pause: this stops everything.
 *
 * Fires on either condition, because they mean different things and both are
 * bad. A high failure rate means something changed underneath us. A 401 or 403
 * means the token or a scope is gone, and every subsequent request will fail
 * identically — retrying just burns quota against a certainty.
 */
export function shouldHalt(args: {
  recentResponses: Array<{ code: number | null; isWrite: boolean }>;
  failureThreshold: number;
}): { halt: boolean; reason: string | null } {
  const auth = args.recentResponses.find((r) => r.code === 401 || r.code === 403);
  if (auth) {
    return {
      halt: true,
      reason: `Received ${auth.code} from LinkedIn. Token or scope is gone; halting rather than retrying.`,
    };
  }

  const writes = args.recentResponses.filter((r) => r.isWrite);
  if (writes.length === 0) return { halt: false, reason: null };

  const failed = writes.filter((r) => r.code === null || r.code >= 400).length;
  const rate = failed / writes.length;

  if (rate > args.failureThreshold) {
    return {
      halt: true,
      reason: `Publish failure rate ${(rate * 100).toFixed(0)}% over the last hour exceeds the ${(args.failureThreshold * 100).toFixed(0)}% threshold (${failed}/${writes.length}).`,
    };
  }

  return { halt: false, reason: null };
}
