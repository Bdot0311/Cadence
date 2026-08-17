import type { OAuthConfig } from './oauth.js';

/**
 * Two LinkedIn developer apps, because LinkedIn requires it.
 *
 * Community Management API "requires that it be the only product on the
 * application for legal and security reasons". It cannot sit alongside Share on
 * LinkedIn or Sign In with LinkedIn — the console greys out the request button
 * when any other product is provisioned or pending. The only way to hold both
 * capabilities is two separate apps.
 *
 * That has a consequence worth stating plainly, because getting it wrong
 * produces a confusing failure: a refresh token can ONLY be redeemed with the
 * client credentials of the app that issued it. Refreshing a Community token
 * with the primary app's client_id fails as an invalid_grant, which reads like
 * an expired token rather than a config error. Every account therefore records
 * which app minted it, and the refresh job looks the credentials up by that.
 */
export type LinkedInAppId = 'primary' | 'community';

export const LINKEDIN_APPS: Record<
  LinkedInAppId,
  { label: string; products: string[]; scopes: string[] }
> = {
  primary: {
    label: 'Primary (personal profile)',
    products: ['Share on LinkedIn', 'Sign In with LinkedIn using OpenID Connect'],
    scopes: ['openid', 'profile', 'email', 'w_member_social'],
  },
  community: {
    label: 'Community (company page + engagement)',
    // Must be the ONLY product on this app. Adding anything else here is not a
    // config choice — LinkedIn will refuse to provision it.
    products: ['Community Management API'],
    scopes: ['r_organization_social', 'w_organization_social'],
  },
};

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export class AppNotConfiguredError extends Error {
  constructor(readonly appId: LinkedInAppId) {
    super(
      appId === 'community'
        ? `The Community app is not configured. Community Management API must live on ` +
            `its own LinkedIn app — it cannot share one with Share on LinkedIn. Create a ` +
            `second app, then set LINKEDIN_CMA_CLIENT_ID and LINKEDIN_CMA_CLIENT_SECRET.`
        : `The primary LinkedIn app is not configured. Set LINKEDIN_CLIENT_ID and ` +
            `LINKEDIN_CLIENT_SECRET.`,
    );
    this.name = 'AppNotConfiguredError';
  }
}

/**
 * Resolves credentials per app.
 *
 * Deliberately throws rather than falling back to the primary app when the
 * community app is missing. A silent fallback would send a Community OAuth
 * request with primary credentials, and LinkedIn would return a scope error
 * that looks like an approval problem instead of a missing config value.
 */
export class AppRegistry {
  constructor(
    private readonly apps: Partial<Record<LinkedInAppId, AppCredentials>>,
  ) {}

  isConfigured(appId: LinkedInAppId): boolean {
    const a = this.apps[appId];
    return Boolean(a?.clientId && a.clientSecret);
  }

  get(appId: LinkedInAppId): AppCredentials {
    const a = this.apps[appId];
    if (!a?.clientId || !a.clientSecret) {
      throw new AppNotConfiguredError(appId);
    }
    return a;
  }

  oauthFor(appId: LinkedInAppId): OAuthConfig {
    const a = this.get(appId);
    return {
      clientId: a.clientId,
      clientSecret: a.clientSecret,
      redirectUri: a.redirectUri,
      scopes: a.scopes,
    };
  }

  configured(): LinkedInAppId[] {
    return (Object.keys(this.apps) as LinkedInAppId[]).filter((id) =>
      this.isConfigured(id),
    );
  }
}

/**
 * Which app an account's token came from.
 *
 * Falls back to 'primary' when the column is null, which is what every account
 * created before the two-app split looks like. Those tokens were all issued by
 * the original single app, so 'primary' is correct rather than merely
 * convenient.
 */
export function appIdForAccount(stored: string | null | undefined): LinkedInAppId {
  return stored === 'community' ? 'community' : 'primary';
}

/**
 * The scope a capability needs, and therefore which app must have issued the
 * token being used for it. Keeps the mapping in one place so a new capability
 * cannot silently be attempted against the wrong app.
 */
export function appForScope(scope: string): LinkedInAppId {
  return scope.startsWith('r_organization') || scope.startsWith('w_organization')
    ? 'community'
    : 'primary';
}
