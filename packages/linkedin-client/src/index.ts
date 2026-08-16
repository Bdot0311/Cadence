/**
 * @agent/linkedin-client
 *
 * A well-behaved client for the sanctioned LinkedIn API.
 *
 * Scope is enforced by what this module exports. There is no message send or
 * read, no organization write, no feed read, no profile search, and no
 * connection request — not because they're disabled, but because no code
 * implementing them exists in this package. See LIMITS.md before adding any.
 *
 * Every request is recorded to the ledger. Every write is gated pre-flight
 * against the daily budget and the kill switch. 429/503 back off exponentially
 * with full jitter and honour Retry-After. 401/403 throw immediately without
 * retrying, so the anomaly halt fires instead of a silent backoff loop.
 */

import { LinkedInHttp, type HttpConfig } from './http.js';
import { LinkedInOAuth, type OAuthConfig } from './oauth.js';
import { Media } from './media.js';
import { Posts } from './posts.js';

export { LinkedInHttp, parseQuota, backoffMs } from './http.js';
export type { HttpConfig, RequestOptions, RawResponse } from './http.js';
export { LinkedInOAuth } from './oauth.js';
export type { OAuthConfig, TokenSet } from './oauth.js';
export { Posts } from './posts.js';
export { Media } from './media.js';
export {
  LinkedInError,
  BudgetExceededError,
  WritesHaltedError,
} from './errors.js';
export {
  MemberUrn,
  ShareUrn,
  ImageUrn,
  PostVisibility,
  CreatePostRequest,
  TokenResponse,
  UserInfo,
} from './types.js';
export type {
  QuotaSnapshot,
  LedgerEntry,
  LedgerSink,
  WriteGuard,
  CreatePostResult,
} from './types.js';

export interface LinkedInClientConfig extends HttpConfig {
  oauth: OAuthConfig;
}

/** Convenience wiring. Everything is also constructible individually. */
export class LinkedInClient {
  readonly http: LinkedInHttp;
  readonly oauth: LinkedInOAuth;
  readonly posts: Posts;
  readonly media: Media;

  constructor(config: LinkedInClientConfig) {
    const { oauth, ...httpConfig } = config;
    this.http = new LinkedInHttp(httpConfig);
    this.oauth = new LinkedInOAuth(this.http, oauth);
    this.posts = new Posts(this.http);
    this.media = new Media(this.http);
  }
}
