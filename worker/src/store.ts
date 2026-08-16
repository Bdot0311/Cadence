import type { SupabaseClient } from '@supabase/supabase-js';
import type { LedgerEntry, TokenSet } from '@agent/linkedin-client';
import type { GuardStore } from './lib/guard.js';
import type {
  DuePost,
  SchedulerAccount,
  SchedulerDeps,
} from './jobs/scheduler.js';
import type { RefreshableAccount, RefreshDeps } from './jobs/refresh-tokens.js';
import type { ScheduleConfig } from './lib/windows.js';

type JsonObject = Record<string, unknown>;

export class SupabaseRuntimeStore implements GuardStore {
  constructor(private readonly db: SupabaseClient) {}

  async writesToday(accountId: string): Promise<number> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const { count, error } = await this.db
      .from('rate_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('is_write', true)
      .gte('created_at', since.toISOString());
    throwIf(error);
    return count ?? 0;
  }

  async rateLimitHitsInLastHour(accountId: string): Promise<number> {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error } = await this.db
      .from('rate_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .in('response_code', [429, 503])
      .gte('created_at', since);
    throwIf(error);
    return count ?? 0;
  }

  async pausedUntil(accountId: string): Promise<Date | null> {
    const { data, error } = await this.db
      .from('accounts').select('paused_until').eq('id', accountId).single();
    throwIf(error);
    return dateOrNull(data?.paused_until);
  }

  async pauseAccount(accountId: string, until: Date, reason: string): Promise<void> {
    const { error } = await this.db.from('accounts').update({
      paused_until: until.toISOString(), pause_reason: reason,
    }).eq('id', accountId);
    throwIf(error);
  }

  async killSwitchEngaged(accountId: string): Promise<boolean> {
    const { data, error } = await this.db.from('agent_config')
      .select('kill_switch_engaged').eq('account_id', accountId).single();
    throwIf(error);
    return data?.kill_switch_engaged === true;
  }

  async dryRunUntil(accountId: string): Promise<Date | null> {
    const { data, error } = await this.db.from('agent_config')
      .select('dry_run_until').eq('account_id', accountId).single();
    throwIf(error);
    return dateOrNull(data?.dry_run_until);
  }

  async insertLedgerRow(entry: LedgerEntry): Promise<void> {
    const { error } = await this.db.from('rate_ledger').insert({
      account_id: entry.accountId,
      endpoint: entry.endpoint,
      method: entry.method,
      response_code: entry.responseCode,
      quota_remaining: entry.quota.remaining,
      quota_limit: entry.quota.limit,
      quota_reset_at: entry.quota.resetAt?.toISOString() ?? null,
      retry_after_s: entry.quota.retryAfterSeconds,
      is_write: entry.isWrite,
      duration_ms: entry.durationMs,
      error_body: entry.errorBody,
    });
    throwIf(error);
  }

  async globalKillSwitchEngaged(): Promise<boolean> {
    const { count, error } = await this.db.from('agent_config')
      .select('account_id', { count: 'exact', head: true })
      .eq('kill_switch_engaged', true);
    throwIf(error);
    return (count ?? 0) > 0;
  }

  async recentResponses(): Promise<Array<{ code: number | null; isWrite: boolean }>> {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data, error } = await this.db.from('rate_ledger')
      .select('response_code,is_write').gte('created_at', since);
    throwIf(error);
    return (data ?? []).map((row) => ({
      code: typeof row.response_code === 'number' ? row.response_code : null,
      isWrite: row.is_write === true,
    }));
  }

  async raiseHalt(reason: string): Promise<void> {
    const { error } = await this.db.from('agent_config').update({
      kill_switch_engaged: true,
      halt_reason: reason,
      halted_at: new Date().toISOString(),
    }).eq('kill_switch_engaged', false);
    throwIf(error);
  }

  async activeAccounts(): Promise<SchedulerAccount[]> {
    const { data, error } = await this.db.from('accounts')
      .select('id,urn,paused_until,agent_config(timezone,schedule)')
      .eq('active', true);
    throwIf(error);
    return Promise.all((data ?? []).map(async (row) => {
      const tokens = await this.tokens(row.id);
      const relation = firstRelation(row.agent_config) as JsonObject | null;
      return {
        id: row.id,
        urn: row.urn,
        accessToken: tokens.accessToken,
        schedule: parseSchedule(relation?.['timezone'], relation?.['schedule']),
        cooldownUntil: dateOrNull(row.paused_until),
      };
    }));
  }

  async duePosts(accountId: string, now: Date): Promise<DuePost[]> {
    const { data, error } = await this.db.from('post_queue')
      .select('id,account_id,body,media_urns,scheduled_at')
      .eq('account_id', accountId)
      .in('state', ['approved', 'scheduled'])
      .or(`scheduled_at.is.null,scheduled_at.lte.${now.toISOString()}`)
      .order('scheduled_at', { ascending: true, nullsFirst: true });
    throwIf(error);
    return (data ?? []).map((row) => ({
      id: row.id,
      accountId: row.account_id,
      body: row.body,
      mediaUrns: Array.isArray(row.media_urns) ? row.media_urns : [],
      scheduledAt: dateOrNull(row.scheduled_at),
    }));
  }

  async publishedPosts(accountId: string): Promise<Array<{ publishedAt: Date }>> {
    const since = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.db.from('post_queue').select('published_at')
      .eq('account_id', accountId).eq('state', 'published').gte('published_at', since);
    throwIf(error);
    return (data ?? []).flatMap((row) => row.published_at
      ? [{ publishedAt: new Date(row.published_at) }] : []);
  }

  async markPublished(postId: string, urn: string, at: Date): Promise<void> {
    const { error } = await this.db.from('post_queue').update({
      state: 'published', published_urn: urn, published_at: at.toISOString(), failure_reason: null,
    }).eq('id', postId);
    throwIf(error);
  }

  async markFailed(postId: string, reason: string): Promise<void> {
    const { error } = await this.db.from('post_queue').update({
      state: 'failed', failure_reason: reason,
    }).eq('id', postId);
    throwIf(error);
  }

  async reschedule(postId: string, to: Date, reason: string): Promise<void> {
    const { error } = await this.db.from('post_queue').update({
      state: 'scheduled', scheduled_at: to.toISOString(), failure_reason: reason,
    }).eq('id', postId);
    throwIf(error);
  }

  async log(entry: Parameters<SchedulerDeps['log']>[0]): Promise<void> {
    const { error } = await this.db.from('agent_log').insert({
      account_id: entry.accountId,
      stage: entry.stage,
      level: entry.level,
      decision: entry.decision,
      rationale: entry.rationale,
      post_id: entry.postId ?? null,
    });
    throwIf(error);
  }

  async refreshableAccounts(): Promise<RefreshableAccount[]> {
    const { data, error } = await this.db.from('accounts')
      .select('id,display_name,token_expires_at,refresh_expires_at').eq('active', true);
    throwIf(error);
    return Promise.all((data ?? []).map(async (row) => {
      const tokens = await this.tokens(row.id);
      return {
        id: row.id,
        displayName: row.display_name,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: new Date(row.token_expires_at),
        refreshExpiresAt: dateOrNull(row.refresh_expires_at),
      };
    }));
  }

  async saveTokens(accountId: string, tokens: TokenSet): Promise<void> {
    const { error } = await this.db.rpc('save_account_tokens', {
      target_account_id: accountId,
      new_access_token: tokens.accessToken,
      new_refresh_token: tokens.refreshToken,
      new_token_expires_at: tokens.expiresAt.toISOString(),
      new_refresh_expires_at: tokens.refreshExpiresAt?.toISOString() ?? null,
      new_scopes: tokens.scopes,
    });
    throwIf(error);
  }

  async deactivate(accountId: string, reason: string): Promise<void> {
    const { error } = await this.db.from('accounts').update({
      active: false, pause_reason: reason, paused_until: null,
    }).eq('id', accountId);
    throwIf(error);
  }

  schedulerDeps(posts: SchedulerDeps['posts'], config: {
    envKillSwitch: boolean; failureThreshold: number;
  }): SchedulerDeps {
    return {
      ...config,
      globalKillSwitchEngaged: () => this.globalKillSwitchEngaged(),
      recentResponses: () => this.recentResponses(),
      raiseHalt: (reason) => this.raiseHalt(reason),
      activeAccounts: () => this.activeAccounts(),
      duePosts: (id, now) => this.duePosts(id, now),
      publishedPosts: (id) => this.publishedPosts(id),
      posts,
      markPublished: (id, urn, at) => this.markPublished(id, urn, at),
      markFailed: (id, reason) => this.markFailed(id, reason),
      reschedule: (id, to, reason) => this.reschedule(id, to, reason),
      log: (entry) => this.log(entry),
    };
  }

  refreshDeps(oauth: RefreshDeps['oauth'], alert: RefreshDeps['alert']): RefreshDeps {
    return {
      accounts: () => this.refreshableAccounts(), oauth,
      saveTokens: (id, tokens) => this.saveTokens(id, tokens),
      deactivate: (id, reason) => this.deactivate(id, reason),
      alert,
      log: (entry) => this.log(entry),
    };
  }

  private async tokens(accountId: string): Promise<{ accessToken: string; refreshToken: string | null }> {
    const { data, error } = await this.db.rpc('get_account_tokens', {
      target_account_id: accountId,
    });
    throwIf(error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.access_token) throw new Error(`No decryptable access token for account ${accountId}`);
    return { accessToken: row.access_token, refreshToken: row.refresh_token ?? null };
  }
}

function parseSchedule(timezone: unknown, value: unknown): ScheduleConfig {
  const schedule = isObject(value) ? value : {};
  return {
    timezone: typeof timezone === 'string' ? timezone : 'America/New_York',
    windows: Array.isArray(schedule['windows']) ? schedule['windows'] as ScheduleConfig['windows'] : [],
    minGapMinutes: numberOr(schedule['min_gap_minutes'], 240),
    dailyCap: numberOr(schedule['daily_cap'], 1),
    weeklyCap: numberOr(schedule['weekly_cap'], 5),
    jitterMinutes: numberOr(schedule['jitter_minutes'], 12),
  };
}

function firstRelation(value: unknown): unknown {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dateOrNull(value: unknown): Date | null {
  return typeof value === 'string' ? new Date(value) : null;
}

function throwIf(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}
