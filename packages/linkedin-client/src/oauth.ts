import { LinkedInError } from './errors.js';
import type { LinkedInHttp } from './http.js';
import { TokenResponse, UserInfo, MemberUrn } from './types.js';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface TokenSet {
  accessToken: string;
  /** Absolute expiry, computed from expires_in at exchange time. */
  expiresAt: Date;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
  scopes: string[];
}

/**
 * Three-legged OAuth for LinkedIn.
 *
 * v1 requests `openid profile email w_member_social` and nothing else. The
 * org scopes are deliberately absent — they require Community Management API
 * approval, and requesting a scope the app doesn't hold fails the whole
 * authorization rather than degrading. See LIMITS.md.
 */
export class LinkedInOAuth {
  constructor(
    private readonly http: LinkedInHttp,
    private readonly cfg: OAuthConfig,
  ) {}

  /**
   * Build the authorization URL the founder visits.
   *
   * `state` is caller-supplied and must be verified on the callback — it is
   * the CSRF defence for the redirect, not decoration.
   */
  authorizationUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      state,
      scope: this.cfg.scopes.join(' '),
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
    });
  }

  /**
   * Refresh an access token.
   *
   * LinkedIn may or may not return a new refresh_token. When it doesn't, the
   * existing one stays valid until its own 365-day expiry — the caller must
   * keep the old value rather than nulling it out.
   */
  async refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  /**
   * Sign In with LinkedIn (OIDC). Returns the member's author URN, which is
   * what every subsequent POST /rest/posts is authored as.
   */
  async fetchMemberUrn(accessToken: string): Promise<{
    urn: string;
    displayName: string;
    email: string | null;
  }> {
    const res = await this.http.request({
      method: 'GET',
      path: '/userinfo',
      base: 'v2',
      accessToken,
    });

    const parsed = UserInfo.safeParse(safeJson(res.text));
    if (!parsed.success) {
      throw new LinkedInError(
        `Unrecognised /userinfo response shape: ${parsed.error.message}`,
        { status: res.status, endpoint: '/userinfo', body: res.text },
      );
    }

    const urn = MemberUrn.parse(`urn:li:person:${parsed.data.sub}`);
    return {
      urn,
      displayName: parsed.data.name ?? 'LinkedIn member',
      email: parsed.data.email ?? null,
    };
  }

  private async tokenRequest(
    fields: Record<string, string>,
  ): Promise<TokenSet> {
    const body = new URLSearchParams({
      ...fields,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });

    const res = await this.http.request({
      method: 'POST',
      path: '/accessToken',
      base: 'oauth',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      rawBody: new TextEncoder().encode(body.toString()),
    });

    const parsed = TokenResponse.safeParse(safeJson(res.text));
    if (!parsed.success) {
      throw new LinkedInError(
        `Unrecognised token response shape: ${parsed.error.message}`,
        { status: res.status, endpoint: '/accessToken', body: res.text },
      );
    }

    const now = Date.now();
    const t = parsed.data;

    return {
      accessToken: t.access_token,
      expiresAt: new Date(now + t.expires_in * 1000),
      refreshToken: t.refresh_token ?? null,
      refreshExpiresAt:
        t.refresh_token_expires_in === undefined
          ? null
          : new Date(now + t.refresh_token_expires_in * 1000),
      scopes: t.scope ? t.scope.split(/[\s,]+/).filter(Boolean) : [],
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
