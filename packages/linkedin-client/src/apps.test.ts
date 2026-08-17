import { describe, expect, it } from 'vitest';
import {
  AppNotConfiguredError,
  AppRegistry,
  LINKEDIN_APPS,
  appForScope,
  appIdForAccount,
  type AppCredentials,
} from './apps.js';

const primary: AppCredentials = {
  clientId: 'primary-id',
  clientSecret: 'primary-secret',
  redirectUri: 'http://localhost:8080/auth/linkedin/callback',
  scopes: ['openid', 'profile', 'email', 'w_member_social'],
};

const community: AppCredentials = {
  clientId: 'community-id',
  clientSecret: 'community-secret',
  redirectUri: 'http://localhost:8080/auth/linkedin/community/callback',
  scopes: ['r_organization_social', 'w_organization_social'],
};

describe('app definitions', () => {
  it('keeps Community Management API alone on its app', () => {
    // LinkedIn refuses to provision it alongside anything else. This is a
    // platform rule, not a preference, so the definition encodes it.
    expect(LINKEDIN_APPS.community.products).toEqual(['Community Management API']);
  });

  it('keeps the member-publishing products off the community app', () => {
    expect(LINKEDIN_APPS.community.products).not.toContain('Share on LinkedIn');
    expect(LINKEDIN_APPS.community.scopes).not.toContain('w_member_social');
  });

  it('keeps org scopes off the primary app', () => {
    expect(LINKEDIN_APPS.primary.scopes).not.toContain('w_organization_social');
    expect(LINKEDIN_APPS.primary.scopes).not.toContain('r_organization_social');
  });
});

describe('AppRegistry', () => {
  it('resolves credentials per app', () => {
    const r = new AppRegistry({ primary, community });
    expect(r.get('primary').clientId).toBe('primary-id');
    expect(r.get('community').clientId).toBe('community-id');
  });

  it('builds an OAuth config with the matching redirect and scopes', () => {
    const r = new AppRegistry({ primary, community });
    const cfg = r.oauthFor('community');
    expect(cfg.clientId).toBe('community-id');
    expect(cfg.scopes).toEqual(['r_organization_social', 'w_organization_social']);
    expect(cfg.redirectUri).toMatch(/community\/callback$/);
  });

  /**
   * The important one. Falling back to the primary app would send a Community
   * OAuth request with the wrong client_id, and LinkedIn's error reads like an
   * approval problem rather than a missing config value.
   */
  it('throws rather than falling back when the community app is unconfigured', () => {
    const r = new AppRegistry({ primary });
    expect(r.isConfigured('community')).toBe(false);
    const err = grab(() => r.get('community'));
    expect(err).toBeInstanceOf(AppNotConfiguredError);
    expect(err.message).toMatch(/cannot share one with Share on LinkedIn/);
    expect(err.message).toMatch(/LINKEDIN_CMA_CLIENT_ID/);
  });

  it('treats a half-filled app as unconfigured', () => {
    const r = new AppRegistry({
      community: { ...community, clientSecret: '' },
    });
    expect(r.isConfigured('community')).toBe(false);
  });

  it('lists only fully configured apps', () => {
    expect(new AppRegistry({ primary }).configured()).toEqual(['primary']);
    expect(new AppRegistry({ primary, community }).configured().sort()).toEqual([
      'community',
      'primary',
    ]);
  });
});

describe('appIdForAccount', () => {
  it('maps a stored community account', () => {
    expect(appIdForAccount('community')).toBe('community');
  });

  it('treats pre-split accounts as primary', () => {
    // Every account created before the two-app change has a null column, and
    // its token really was issued by the original single app.
    expect(appIdForAccount(null)).toBe('primary');
    expect(appIdForAccount(undefined)).toBe('primary');
    expect(appIdForAccount('primary')).toBe('primary');
  });

  it('does not silently accept an unknown value as community', () => {
    expect(appIdForAccount('something-else')).toBe('primary');
  });
});

describe('appForScope', () => {
  it.each([
    ['w_member_social', 'primary'],
    ['openid', 'primary'],
    ['r_organization_social', 'community'],
    ['w_organization_social', 'community'],
  ])('routes %s to the %s app', (scope, expected) => {
    expect(appForScope(scope)).toBe(expected);
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
