import { z } from 'zod';

/**
 * Zod schemas for every LinkedIn API boundary this client touches.
 *
 * Responses are parsed, not cast. LinkedIn ships breaking changes between
 * LinkedIn-Version values, and a silently-shaped-wrong response is how you end
 * up storing `undefined` as a published URN and never noticing.
 */

// --- URNs -------------------------------------------------------------------

/**
 * v1 authors as a member only. This regex is the enforcement point for
 * "no org writes" — an organization URN cannot be constructed through the
 * public surface of this package. See LIMITS.md.
 */
export const MemberUrn = z
  .string()
  .regex(/^urn:li:person:[A-Za-z0-9_-]+$/, 'must be a urn:li:person URN');

export const ShareUrn = z
  .string()
  .regex(/^urn:li:(share|ugcPost):[0-9]+$/, 'must be a share or ugcPost URN');

export const ImageUrn = z
  .string()
  .regex(/^urn:li:image:[A-Za-z0-9_-]+$/, 'must be an image URN');

export type MemberUrn = z.infer<typeof MemberUrn>;
export type ShareUrn = z.infer<typeof ShareUrn>;
export type ImageUrn = z.infer<typeof ImageUrn>;

// --- OAuth ------------------------------------------------------------------

export const TokenResponse = z.object({
  access_token: z.string().min(1),
  /** Seconds. LinkedIn issues 60-day access tokens (~5184000). */
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  /** Seconds. 365-day refresh token (~31536000). */
  refresh_token_expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

/** Sign In with LinkedIn using OpenID Connect — GET /v2/userinfo */
export const UserInfo = z.object({
  /** The member id. Author URN is `urn:li:person:${sub}`. */
  sub: z.string().min(1),
  name: z.string().optional(),
  email: z.string().optional(),
  picture: z.string().optional(),
});
export type UserInfo = z.infer<typeof UserInfo>;

// --- Posts ------------------------------------------------------------------

export const PostVisibility = z.enum(['PUBLIC', 'CONNECTIONS']);
export type PostVisibility = z.infer<typeof PostVisibility>;

/**
 * Request body for POST /rest/posts.
 *
 * Note there is no `distribution.feedDistribution: 'NONE'` escape hatch exposed
 * here. Everything this agent publishes is meant to be seen.
 */
export const CreatePostRequest = z.object({
  author: MemberUrn,
  commentary: z.string().min(1).max(3000),
  visibility: PostVisibility.default('PUBLIC'),
  /** Image URNs from /rest/images, attached in order. */
  media: z.array(ImageUrn).max(20).default([]),
  /** Shown above the media carousel when media is present. */
  mediaTitle: z.string().max(200).optional(),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequest>;

/**
 * POST /rest/posts returns 201 with the URN in the `x-restli-id` header and
 * an empty body. We normalise that into an object.
 */
export const CreatePostResult = z.object({
  urn: ShareUrn,
});
export type CreatePostResult = z.infer<typeof CreatePostResult>;

// --- Media ------------------------------------------------------------------

/** POST /rest/images?action=initializeUpload */
export const InitializeUploadResponse = z.object({
  value: z.object({
    uploadUrl: z.string().url(),
    image: ImageUrn,
  }),
});
export type InitializeUploadResponse = z.infer<typeof InitializeUploadResponse>;

// --- Rate limiting ----------------------------------------------------------

/**
 * Quota headers, parsed off every response. LinkedIn does not send these
 * consistently across endpoints, so every field is optional and the ledger
 * stores nulls rather than guessing.
 */
export interface QuotaSnapshot {
  remaining: number | null;
  limit: number | null;
  resetAt: Date | null;
  retryAfterSeconds: number | null;
}

/** One row destined for `rate_ledger`. */
export interface LedgerEntry {
  accountId: string | null;
  endpoint: string;
  method: string;
  responseCode: number | null;
  quota: QuotaSnapshot;
  isWrite: boolean;
  durationMs: number;
  errorBody: string | null;
}

/**
 * Sink for ledger entries. The client does not know about Postgres — the
 * worker injects an implementation. Keeps this package testable without a
 * database and keeps the Supabase dependency out of the HTTP layer.
 */
export interface LedgerSink {
  record(entry: LedgerEntry): Promise<void>;
}

/**
 * Pre-flight gate consulted before every write. Implemented by the worker
 * against `rate_ledger` + `accounts.paused_until` + the kill switch.
 */
export interface WriteGuard {
  /**
   * Throws BudgetExceededError or WritesHaltedError to block the request.
   * Resolves to void to allow it. Called before the request is built, so a
   * blocked write costs nothing.
   */
  assertCanWrite(accountId: string): Promise<void>;

  /**
   * Called after a 429/503. The guard decides whether this trips the
   * "twice in an hour" rule and pauses the account for the rest of the day.
   */
  onRateLimited(accountId: string, quota: QuotaSnapshot): Promise<void>;
}
