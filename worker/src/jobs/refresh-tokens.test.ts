import { describe, expect, it, vi } from 'vitest';
import { LinkedInError, type TokenSet } from '@agent/linkedin-client';
import {
  RENEW_WITHIN_DAYS,
  runTokenRefresh,
  type RefreshDeps,
  type RefreshableAccount,
} from './refresh-tokens.js';

const T0 = new Date('2026-08-15T12:00:00Z');
const days = (n: number) => new Date(T0.getTime() + n * 24 * 60 * 60 * 1000);

function account(o: Partial<RefreshableAccount> = {}): RefreshableAccount {
  return {
    id: 'a1',
    displayName: 'Brandon Yakubov',
    refreshToken: 'refresh-abc',
    // Fresh 60-day access token, 365-day refresh token.
    tokenExpiresAt: days(60),
    refreshExpiresAt: days(365),
    ...o,
  };
}

function tokenSet(o: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: 'new-access',
    expiresAt: days(60),
    refreshToken: 'new-refresh',
    refreshExpiresAt: days(365),
    scopes: ['w_member_social'],
    ...o,
  };
}

function deps(o: { accounts?: RefreshableAccount[]; refresh?: RefreshDeps['oauth']['refresh'] } = {}) {
  const saved: Array<{ accountId: string; tokens: TokenSet }> = [];
  const alerts: Array<{ subject: string; body: string }> = [];
  const deactivations: Array<{ accountId: string; reason: string }> = [];
  const logs: Array<{ decision: string; rationale: string }> = [];

  const refresh = o.refresh ?? vi.fn(async () => tokenSet());

  const d: RefreshDeps = {
    async accounts() { return o.accounts ?? [account()]; },
    oauth: { refresh },
    async saveTokens(accountId, tokens) { saved.push({ accountId, tokens }); },
    async deactivate(accountId, reason) { deactivations.push({ accountId, reason }); },
    async alert(subject, body) { alerts.push({ subject, body }); },
    async log(e) { logs.push({ decision: e.decision, rationale: e.rationale }); },
  };

  return { deps: d, saved, alerts, deactivations, logs, refresh };
}

// --- T-7 renewal: acceptance criterion 5 ------------------------------------

describe('renewal window', () => {
  it('does nothing on a fresh 60-day token', async () => {
    const h = deps();
    const r = await runTokenRefresh({ now: T0, deps: h.deps });
    expect(r[0]).toMatchObject({ action: 'skipped' });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('does nothing at T-8 days', async () => {
    const h = deps({ accounts: [account({ tokenExpiresAt: days(8) })] });
    const r = await runTokenRefresh({ now: T0, deps: h.deps });
    expect(r[0]).toMatchObject({ action: 'skipped' });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('renews at exactly T-7 days', async () => {
    const h = deps({ accounts: [account({ tokenExpiresAt: days(RENEW_WITHIN_DAYS) })] });
    const r = await runTokenRefresh({ now: T0, deps: h.deps });
    expect(r[0]).toMatchObject({ action: 'renewed' });
    expect(h.refresh).toHaveBeenCalledWith('refresh-abc');
    expect(h.saved).toHaveLength(1);
  });

  /**
   * Fast-forwards the clock across a full token lifetime rather than asserting
   * a single instant. This is the criterion-5 test: run the job every day for
   * 60 days and confirm it renews once, at T-7, and never lets the token lapse.
   */
  it('renews exactly once when the clock is fast-forwarded across 60 days', async () => {
    let current = account();
    const renewals: Date[] = [];

    for (let day = 0; day <= 60; day++) {
      const now = days(day);
      const h = deps({
        accounts: [current],
        refresh: vi.fn(async () =>
          tokenSet({ expiresAt: new Date(now.getTime() + 60 * 86_400_000) }),
        ),
      });

      await runTokenRefresh({ now, deps: h.deps });

      if (h.saved.length > 0) {
        renewals.push(now);
        const t = h.saved[0]!.tokens;
        current = {
          ...current,
          tokenExpiresAt: t.expiresAt,
          refreshToken: t.refreshToken,
          refreshExpiresAt: t.refreshExpiresAt,
        };
      }

      // The invariant that matters: the access token is never expired on a day
      // the job has already run.
      expect(current.tokenExpiresAt.getTime(), `day ${day}`).toBeGreaterThan(now.getTime());
    }

    expect(renewals).toHaveLength(1);
    // Renewed on day 53, which is T-7 against the original day-60 expiry.
    expect(renewals[0]?.toISOString()).toBe(days(53).toISOString());
  });
});

// --- refresh token carry-forward --------------------------------------------

describe('refresh token handling', () => {
  it('carries the existing refresh token forward when LinkedIn omits a new one', async () => {
    const h = deps({
      accounts: [account({ tokenExpiresAt: days(3) })],
      refresh: vi.fn(async () =>
        tokenSet({ refreshToken: null, refreshExpiresAt: null }),
      ),
    });

    await runTokenRefresh({ now: T0, deps: h.deps });

    // Nulling these would force a manual re-auth a month early.
    expect(h.saved[0]?.tokens.refreshToken).toBe('refresh-abc');
    expect(h.saved[0]?.tokens.refreshExpiresAt?.toISOString()).toBe(days(365).toISOString());
  });

  it('prefers a newly issued refresh token when LinkedIn sends one', async () => {
    const h = deps({ accounts: [account({ tokenExpiresAt: days(3) })] });
    await runTokenRefresh({ now: T0, deps: h.deps });
    expect(h.saved[0]?.tokens.refreshToken).toBe('new-refresh');
  });

  it('keeps a valid account connected when LinkedIn issued no refresh token', async () => {
    const h = deps({ accounts: [account({ refreshToken: null, refreshExpiresAt: null })] });
    const r = await runTokenRefresh({ now: T0, deps: h.deps });
    expect(r[0]).toMatchObject({ action: 'skipped', reason: expect.stringMatching(/is connected/) });
    expect(h.alerts).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it('warns near expiry when LinkedIn issued no refresh token', async () => {
    const h = deps({ accounts: [account({ refreshToken: null, tokenExpiresAt: days(1) })] });
    const r = await runTokenRefresh({ now: T0, deps: h.deps });
    expect(r[0]).toMatchObject({ action: 'skipped' });
    expect(h.alerts).toHaveLength(1);
    expect(h.logs[0]?.decision).toBe('reauth-needed');
  });

  it('deactivates only after an unrefreshable access token expires', async () => {
    const h = deps({ accounts: [account({ refreshToken: null, tokenExpiresAt: days(-1) })] });
    const r = await runTokenRefresh({ now: T0, deps: h.deps });
    expect(r[0]).toMatchObject({ action: 'reauth-required' });
    expect(h.deactivations).toHaveLength(1);
  });
});

// --- failure handling -------------------------------------------------------

describe('refresh failure', () => {
  it('alerts but does not deactivate, because there are days of runway left', async () => {
    const h = deps({
      accounts: [account({ tokenExpiresAt: days(5) })],
      refresh: vi.fn(async () => {
        throw new LinkedInError('upstream down', { status: 503, endpoint: '/accessToken' });
      }),
    });

    const r = await runTokenRefresh({ now: T0, deps: h.deps });

    expect(r[0]).toMatchObject({ action: 'failed' });
    expect(h.alerts[0]?.subject).toMatch(/token refresh failed/);
    expect(h.alerts[0]?.body).toMatch(/retries daily/);
    expect(h.deactivations).toEqual([]);
  });
});

// --- the un-automatable 365-day wall ----------------------------------------

describe('refresh token expiry', () => {
  it('deactivates and alerts once the refresh token has lapsed', async () => {
    const h = deps({
      accounts: [account({ tokenExpiresAt: days(-1), refreshExpiresAt: days(-1) })],
    });

    const r = await runTokenRefresh({ now: T0, deps: h.deps });

    expect(r[0]).toMatchObject({ action: 'reauth-required' });
    expect(h.deactivations).toHaveLength(1);
    expect(h.deactivations[0]?.reason).toMatch(/Re-authorization is manual/);
    // No attempt to refresh with a dead token.
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('warns 30 days out, while the account is still working', async () => {
    const h = deps({
      accounts: [account({ tokenExpiresAt: days(40), refreshExpiresAt: days(20) })],
    });

    await runTokenRefresh({ now: T0, deps: h.deps });

    expect(h.alerts[0]?.subject).toMatch(/re-authorization needed within 20 days/i);
    expect(h.alerts[0]?.body).toMatch(/cannot do this itself/);
    expect(h.deactivations).toEqual([]);
  });

  it('does not warn when the refresh token is comfortably far out', async () => {
    const h = deps({ accounts: [account({ refreshExpiresAt: days(200) })] });
    await runTokenRefresh({ now: T0, deps: h.deps });
    expect(h.alerts).toEqual([]);
  });
});
