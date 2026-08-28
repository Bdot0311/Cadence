import type { Posts } from '@agent/linkedin-client';
import { BudgetExceededError, LinkedInError, WritesHaltedError } from '@agent/linkedin-client';
import { shouldHalt } from '../lib/guard.js';
import { findSlot, type ScheduleConfig } from '../lib/windows.js';

/**
 * The scheduler tick. Runs every SCHEDULER_INTERVAL_MINUTES (15 by default).
 *
 * Ordering here is the whole design. The kill switch is checked FIRST, before
 * any account is loaded and before any post is considered, which is what makes
 * "halts everything within one scheduler tick" true rather than aspirational.
 * Every other brake lives further down and is per-account.
 *
 * Everything is injected. The tick does no I/O of its own, reads no clock, and
 * imports no Supabase client — which is why the kill-switch and halt paths can
 * be tested without a database or a network.
 */

export interface DuePost {
  id: string;
  accountId: string;
  body: string;
  mediaUrns: string[];
  scheduledAt: Date | null;
}

export interface SchedulerAccount {
  id: string;
  /** Whose credentials this account runs on. Null means unclaimed; skip it. */
  ownerId: string | null;
  urn: string;
  accessToken: string;
  schedule: ScheduleConfig;
  cooldownUntil: Date | null;
}

export interface SchedulerDeps {
  /** Env-level kill switch. Checked before anything else happens. */
  envKillSwitch: boolean;
  /** Dashboard-level kill switch, global across accounts. */
  globalKillSwitchEngaged(): Promise<boolean>;

  /** Responses from the trailing hour, for the anomaly halt. */
  recentResponses(): Promise<Array<{ code: number | null; isWrite: boolean }>>;
  failureThreshold: number;
  /** Persists a halt so it survives process restarts, and alerts. */
  raiseHalt(reason: string): Promise<void>;

  activeAccounts(): Promise<SchedulerAccount[]>;
  duePosts(accountId: string, now: Date): Promise<DuePost[]>;
  publishedPosts(accountId: string): Promise<Array<{ publishedAt: Date }>>;

  /**
   * Per-account client factory, not a shared instance.
   *
   * Each account's owner brings their own LinkedIn app credentials, so a single
   * boot-time client would publish every account through whichever app the
   * process happened to start with. Returning null skips the account — an
   * owner with missing credentials must not run on someone else's keys.
   */
  postsFor(account: SchedulerAccount): Promise<Posts | null>;

  markPublished(postId: string, urn: string, at: Date): Promise<void>;
  markFailed(postId: string, reason: string): Promise<void>;
  reschedule(postId: string, to: Date, reason: string): Promise<void>;

  log(entry: {
    accountId: string | null;
    stage: string;
    level: 'info' | 'warn' | 'error';
    decision: string;
    rationale: string;
    postId?: string;
  }): Promise<void>;

  random?: () => number;
}

export interface TickResult {
  halted: boolean;
  haltReason: string | null;
  published: number;
  failed: number;
  skipped: number;
}

export async function runSchedulerTick(args: {
  now: Date;
  deps: SchedulerDeps;
}): Promise<TickResult> {
  const { now, deps } = args;
  const idle: TickResult = {
    halted: false,
    haltReason: null,
    published: 0,
    failed: 0,
    skipped: 0,
  };

  // ---- 1. Kill switch, before anything else -------------------------------
  // Env first: it is the brake that still works when the database is the thing
  // that broke.
  if (deps.envKillSwitch) {
    await deps.log({
      accountId: null,
      stage: 'halt',
      level: 'warn',
      decision: 'tick aborted',
      rationale: 'AGENT_KILL_SWITCH is set. No accounts loaded, no posts considered.',
    });
    return { ...idle, halted: true, haltReason: 'AGENT_KILL_SWITCH is set' };
  }

  if (await deps.globalKillSwitchEngaged()) {
    await deps.log({
      accountId: null,
      stage: 'halt',
      level: 'warn',
      decision: 'tick aborted',
      rationale: 'Kill switch engaged from the dashboard.',
    });
    return { ...idle, halted: true, haltReason: 'kill switch engaged from the dashboard' };
  }

  // ---- 2. Anomaly halt ----------------------------------------------------
  const halt = shouldHalt({
    recentResponses: await deps.recentResponses(),
    failureThreshold: deps.failureThreshold,
  });
  if (halt.halt && halt.reason) {
    await deps.raiseHalt(halt.reason);
    await deps.log({
      accountId: null,
      stage: 'halt',
      level: 'error',
      decision: 'tick aborted',
      rationale: halt.reason,
    });
    return { ...idle, halted: true, haltReason: halt.reason };
  }

  // ---- 3. Per-account publishing -----------------------------------------
  let published = 0;
  let failed = 0;
  let skipped = 0;

  for (const account of await deps.activeAccounts()) {
    const due = await deps.duePosts(account.id, now);
    if (due.length === 0) continue;

    const alreadyPublished = await deps.publishedPosts(account.id);

    for (const post of due) {
      const slot = findSlot({
        now,
        cfg: account.schedule,
        published: alreadyPublished,
        cooldownUntil: account.cooldownUntil,
        ignoreWindow: post.scheduledAt !== null,
        ignorePacing: post.scheduledAt !== null,
        ...(deps.random ? { random: deps.random } : {}),
      });

      if (!slot.ok) {
        // Not a failure. The post stays queued and is reconsidered next tick.
        skipped++;
        await deps.log({
          accountId: account.id,
          postId: post.id,
          stage: 'schedule',
          level: 'info',
          decision: 'deferred',
          rationale: slot.reason,
        });
        continue;
      }

      // The jittered slot may land past this tick. Park it and let a later tick
      // pick it up, rather than sleeping inside the tick and holding the loop.
      if (slot.scheduledAt.getTime() > now.getTime()) {
        await deps.reschedule(
          post.id,
          slot.scheduledAt,
          `Jittered ${Math.round((slot.scheduledAt.getTime() - now.getTime()) / 60_000)}m inside the window.`,
        );
        skipped++;
        continue;
      }

      try {
        const posts = await deps.postsFor(account);
        if (!posts) {
          skipped++;
          await deps.log({
            accountId: account.id, postId: post.id, stage: 'publish', level: 'warn',
            decision: 'skipped', rationale:
              'Owner has no usable LinkedIn credentials. Skipped rather than published through another account\'s app.',
          });
          break;
        }
        const result = await posts.create({
          accountId: account.id,
          accessToken: account.accessToken,
          author: account.urn,
          commentary: post.body,
          media: post.mediaUrns,
        });

        await deps.markPublished(post.id, result.urn, slot.scheduledAt);
        alreadyPublished.push({ publishedAt: slot.scheduledAt });
        published++;

        await deps.log({
          accountId: account.id,
          postId: post.id,
          stage: 'publish',
          level: 'info',
          decision: 'published',
          rationale: `Published as ${result.urn}.`,
        });
      } catch (err) {
        // A blocked write is not a failed post. The guard stopped it on
        // purpose, so the post stays queued rather than burning a retry.
        if (err instanceof WritesHaltedError || err instanceof BudgetExceededError) {
          skipped++;
          await deps.log({
            accountId: account.id,
            postId: post.id,
            stage: 'publish',
            level: 'info',
            decision: 'blocked',
            rationale: err.message,
          });
          // Both brakes are account-wide; nothing else will publish this tick.
          break;
        }

        failed++;
        const reason =
          err instanceof LinkedInError
            ? `${err.status ?? 'network'}: ${err.message}`
            : String(err);
        await deps.markFailed(post.id, reason);
        await deps.log({
          accountId: account.id,
          postId: post.id,
          stage: 'publish',
          level: 'error',
          decision: 'failed',
          rationale: reason,
        });

        // A fatal error means every later post would fail identically.
        if (err instanceof LinkedInError && err.fatal) {
          await deps.raiseHalt(reason);
          return {
            halted: true,
            haltReason: reason,
            published,
            failed,
            skipped,
          };
        }
      }
    }
  }

  return { halted: false, haltReason: null, published, failed, skipped };
}
