import { describe, expect, it, vi } from 'vitest';
import {
  ORG_SCOPES,
  OrgFeaturesDisabledError,
  assertOrgFeaturesEnabled,
  orgFeaturesAvailable,
  type OrgFeatureContext,
} from './org-features.js';
import { LinkedInHttp } from './http.js';
import { Posts } from './posts.js';
import { SocialActions } from './social-actions.js';
import { Organizations } from './organizations.js';
import type { LedgerEntry, LedgerSink, WriteGuard } from './types.js';

const OFF: OrgFeatureContext = { enabled: false, grantedScopes: [] };
const FLAG_ONLY: OrgFeatureContext = { enabled: true, grantedScopes: [] };
const FULL: OrgFeatureContext = {
  enabled: true,
  grantedScopes: [ORG_SCOPES.read, ORG_SCOPES.write],
};

describe('assertOrgFeaturesEnabled', () => {
  it('blocks when the flag is off', () => {
    const err = grab(() => assertOrgFeaturesEnabled(OFF, 'Publishing', ORG_SCOPES.write));
    expect(err).toBeInstanceOf(OrgFeaturesDisabledError);
    expect((err as OrgFeaturesDisabledError).reason).toBe('flag-off');
    expect(err.message).toMatch(/ORG_FEATURES_ENABLED=true/);
  });

  /**
   * The important case. Flipping the flag without re-running OAuth is the most
   * likely operator mistake after CMA approval lands, and it has to fail
   * locally rather than as a 403 that trips the anomaly halt and stops
   * publishing that was working fine.
   */
  it('blocks when the flag is on but the token lacks the scope', () => {
    const err = grab(() =>
      assertOrgFeaturesEnabled(FLAG_ONLY, 'Publishing', ORG_SCOPES.write),
    );
    expect((err as OrgFeaturesDisabledError).reason).toBe('scope-missing');
    expect(err.message).toMatch(/does not upgrade an existing/);
    expect(err.message).toMatch(/reconnect the account/);
  });

  it('blocks when the token holds only the OTHER org scope', () => {
    const readOnly: OrgFeatureContext = {
      enabled: true,
      grantedScopes: [ORG_SCOPES.read],
    };
    expect(() =>
      assertOrgFeaturesEnabled(readOnly, 'Publishing', ORG_SCOPES.write),
    ).toThrow(OrgFeaturesDisabledError);
    expect(() =>
      assertOrgFeaturesEnabled(readOnly, 'Reading', ORG_SCOPES.read),
    ).not.toThrow();
  });

  it('permits when both conditions hold', () => {
    expect(() =>
      assertOrgFeaturesEnabled(FULL, 'Publishing', ORG_SCOPES.write),
    ).not.toThrow();
  });
});

describe('orgFeaturesAvailable', () => {
  it.each([
    [OFF, false],
    [FLAG_ONLY, false],
    [FULL, true],
  ])('reports availability without throwing', (ctx, expected) => {
    expect(orgFeaturesAvailable(ctx as OrgFeatureContext, ORG_SCOPES.write)).toBe(
      expected,
    );
  });
});

// --- the gate as wired into the client --------------------------------------

class NullLedger implements LedgerSink {
  entries: LedgerEntry[] = [];
  async record(e: LedgerEntry) {
    this.entries.push(e);
  }
}
const permissiveGuard: WriteGuard = {
  async assertCanWrite() {},
  async onRateLimited() {},
};

function harness(ctx: OrgFeatureContext) {
  const fetchImpl = vi.fn(async () => new Response('', { status: 201 }));
  const ledger = new NullLedger();
  const http = new LinkedInHttp({
    apiVersion: '202608',
    ledger,
    guard: permissiveGuard,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: async () => {},
  });
  return {
    fetchImpl,
    ledger,
    posts: new Posts(http, ctx),
    social: new SocialActions(http, ctx),
    orgs: new Organizations(http, ctx),
  };
}

const MEMBER = 'urn:li:person:abc123';
const ORG = 'urn:li:organization:98765';
const SHARE = 'urn:li:share:7001';

describe('org publishing is gated at the URN, not by a caller flag', () => {
  it('refuses a page post when features are off, without touching the network', async () => {
    const h = harness(OFF);
    await expect(
      h.posts.create({
        accountId: 'a1',
        accessToken: 'tok',
        author: ORG,
        commentary: 'hello',
      }),
    ).rejects.toThrow(OrgFeaturesDisabledError);

    // Never reached fetch, so it consumed no quota and left no ledger row.
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.ledger.entries).toEqual([]);
  });

  it('still publishes to the personal profile with org features off', async () => {
    const h = harness(OFF);
    const res = new Response('', {
      status: 201,
      headers: { 'x-restli-id': SHARE },
    });
    h.fetchImpl.mockResolvedValueOnce(res);

    await expect(
      h.posts.create({
        accountId: 'a1',
        accessToken: 'tok',
        author: MEMBER,
        commentary: 'hello',
      }),
    ).resolves.toEqual({ urn: SHARE });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('defaults to closed when no org context is supplied at all', async () => {
    const http = new LinkedInHttp({
      apiVersion: '202608',
      ledger: new NullLedger(),
      guard: permissiveGuard,
      fetchImpl: (async () => new Response('', { status: 201 })) as unknown as typeof fetch,
      sleepImpl: async () => {},
    });
    // Second constructor arg omitted entirely.
    await expect(
      new Posts(http).create({
        accountId: 'a1',
        accessToken: 'tok',
        author: ORG,
        commentary: 'hello',
      }),
    ).rejects.toThrow(OrgFeaturesDisabledError);
  });
});

describe('comment and analytics surfaces are gated', () => {
  it('refuses to read comments without the read scope', async () => {
    const h = harness(FLAG_ONLY);
    await expect(
      h.social.listComments({ accountId: 'a1', accessToken: 't', shareUrn: SHARE }),
    ).rejects.toThrow(OrgFeaturesDisabledError);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to reply without the write scope', async () => {
    const h = harness({ enabled: true, grantedScopes: [ORG_SCOPES.read] });
    await expect(
      h.social.replyToComment({
        accountId: 'a1',
        accessToken: 't',
        shareUrn: SHARE,
        parentComment: `urn:li:comment:(${SHARE},445566)`,
        actor: ORG,
        text: 'thanks',
      }),
    ).rejects.toThrow(OrgFeaturesDisabledError);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses org discovery and analytics without the read scope', async () => {
    const h = harness(OFF);
    await expect(
      h.orgs.listAdministered({ accountId: 'a1', accessToken: 't' }),
    ).rejects.toThrow(OrgFeaturesDisabledError);
    await expect(
      h.orgs.shareStatistics({
        accountId: 'a1',
        accessToken: 't',
        organization: ORG,
        shares: [SHARE],
      }),
    ).rejects.toThrow(OrgFeaturesDisabledError);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

function grab(fn: () => void): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the call to throw, but it did not');
}
