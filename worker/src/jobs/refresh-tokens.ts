import type { LinkedInOAuth, TokenSet } from '@agent/linkedin-client';
import { LinkedInError } from '@agent/linkedin-client';

/**
 * Token refresh.
 *
 * LinkedIn issues a 60-day access token and a 365-day refresh token. We renew
 * at T-7 days, which gives a full week of daily retries before anything breaks.
 *
 * The 365-day refresh expiry has NO programmatic escape: when it lapses, the
 * founder must re-authorize by hand. That is a LinkedIn constraint, not a gap
 * in this job. The job's contribution is to start warning early and loudly
 * rather than discovering it on the day.
 */

export const RENEW_WITHIN_DAYS = 7;
/** Start warning about the un-automatable re-auth this far out. */
export const REAUTH_WARNING_DAYS = 30;

export interface RefreshableAccount {
  id: string;
  displayName: string;
  refreshToken: string | null;
  tokenExpiresAt: Date;
  refreshExpiresAt: Date | null;
}

export interface RefreshDeps {
  accounts(): Promise<RefreshableAccount[]>;
  oauth: Pick<LinkedInOAuth, 'refresh'>;
  /** Persists the new token set, re-encrypting at rest. */
  saveTokens(accountId: string, tokens: TokenSet): Promise<void>;
  /** Marks the account inactive so the scheduler stops trying to publish. */
  deactivate(accountId: string, reason: string): Promise<void>;
  alert(subject: string, body: string): Promise<void>;
  log(entry: {
    accountId: string;
    stage: string;
    level: 'info' | 'warn' | 'error';
    decision: string;
    rationale: string;
  }): Promise<void>;
}

export type RefreshOutcome =
  | { accountId: string; action: 'skipped'; reason: string }
  | { accountId: string; action: 'renewed'; newExpiry: Date }
  | { accountId: string; action: 'failed'; reason: string }
  | { accountId: string; action: 'reauth-required'; reason: string };

export function daysUntil(at: Date, now: Date): number {
  return (at.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
}

export async function runTokenRefresh(args: {
  now: Date;
  deps: RefreshDeps;
}): Promise<RefreshOutcome[]> {
  const { now, deps } = args;
  const results: RefreshOutcome[] = [];

  for (const account of await deps.accounts()) {
    // The un-automatable case, checked first. A refresh token that has already
    // lapsed cannot be used to obtain anything, so there is nothing to try.
    if (account.refreshExpiresAt && account.refreshExpiresAt <= now) {
      const reason =
        `Refresh token expired on ${account.refreshExpiresAt.toISOString()}. ` +
        `Re-authorization is manual — there is no programmatic path back.`;
      await deps.deactivate(account.id, reason);
      await deps.alert(
        `LinkedIn agent: re-authorization required for ${account.displayName}`,
        reason +
          `\n\nThe agent has been deactivated and will not publish until you ` +
          `reconnect the account in the dashboard.`,
      );
      await deps.log({
        accountId: account.id,
        stage: 'refresh',
        level: 'error',
        decision: 'deactivated',
        rationale: reason,
      });
      results.push({ accountId: account.id, action: 'reauth-required', reason });
      continue;
    }

    if (!account.refreshToken) {
      const reason = 'No refresh token stored. Reconnect the account.';
      await deps.log({
        accountId: account.id,
        stage: 'refresh',
        level: 'warn',
        decision: 'skipped',
        rationale: reason,
      });
      results.push({ accountId: account.id, action: 'skipped', reason });
      continue;
    }

    // Early warning for the manual step, well before it bites.
    if (
      account.refreshExpiresAt &&
      daysUntil(account.refreshExpiresAt, now) <= REAUTH_WARNING_DAYS
    ) {
      const days = Math.floor(daysUntil(account.refreshExpiresAt, now));
      await deps.alert(
        `LinkedIn agent: re-authorization needed within ${days} days`,
        `The refresh token for ${account.displayName} expires on ` +
          `${account.refreshExpiresAt.toISOString()}. Renewing it requires you to ` +
          `reconnect the account by hand — the agent cannot do this itself. ` +
          `Publishing stops when it lapses.`,
      );
    }

    const daysLeft = daysUntil(account.tokenExpiresAt, now);
    if (daysLeft > RENEW_WITHIN_DAYS) {
      const reason = `Access token has ${Math.floor(daysLeft)} days left; renewing inside ${RENEW_WITHIN_DAYS}.`;
      results.push({ accountId: account.id, action: 'skipped', reason });
      continue;
    }

    try {
      const tokens = await deps.oauth.refresh(account.refreshToken);

      // LinkedIn may omit a new refresh token. When it does, the existing one
      // stays valid to its own expiry — carrying it forward rather than
      // nulling it is the difference between a working account and a manual
      // re-auth a month early.
      await deps.saveTokens(account.id, {
        ...tokens,
        refreshToken: tokens.refreshToken ?? account.refreshToken,
        refreshExpiresAt: tokens.refreshExpiresAt ?? account.refreshExpiresAt,
      });

      await deps.log({
        accountId: account.id,
        stage: 'refresh',
        level: 'info',
        decision: 'renewed',
        rationale: `Access token renewed, now expires ${tokens.expiresAt.toISOString()}.`,
      });
      results.push({ accountId: account.id, action: 'renewed', newExpiry: tokens.expiresAt });
    } catch (err) {
      const reason =
        err instanceof LinkedInError
          ? `${err.status ?? 'network'}: ${err.message}`
          : String(err);

      // Do not deactivate on a failed refresh. There are days of runway left by
      // design, and a transient failure today is retried tomorrow. Email now so
      // the founder has the whole window to react.
      await deps.alert(
        `LinkedIn agent: token refresh failed for ${account.displayName}`,
        `${reason}\n\nThe access token expires ${account.tokenExpiresAt.toISOString()} ` +
          `(${Math.floor(daysLeft)} days). The job retries daily until then.`,
      );
      await deps.log({
        accountId: account.id,
        stage: 'refresh',
        level: 'error',
        decision: 'failed',
        rationale: reason,
      });
      results.push({ accountId: account.id, action: 'failed', reason });
    }
  }

  return results;
}
