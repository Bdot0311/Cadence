import { z } from 'zod';

/**
 * Zod schemas for every LinkedIn API boundary this client touches.
 *
 * Responses are parsed, not cast. LinkedIn ships breaking changes between
 * LinkedIn-Version values, and a silently-shaped-wrong response is how you end
 * up storing `undefined` as a published URN and never noticing.
 */

// --- URNs -------------------------------------------------------------------

export const MemberUrn = z
  .string()
  .regex(/^urn:li:person:[A-Za-z0-9_-]+$/, 'must be a urn:li:person URN');

/**
 * Organization URN. Writing as an org requires `w_organization_social`, which
 * comes from Community Management API approval — so this type existing does
 * NOT mean org publishing is live. The runtime gate is the granted scope plus
 * the org-features flag; see `assertOrgFeaturesEnabled`.
 */
export const OrganizationUrn = z
  .string()
  .regex(/^urn:li:organization:[0-9]+$/, 'must be a urn:li:organization URN');

/** Anything that can author a post. */
export const AuthorUrn = z.union([MemberUrn, OrganizationUrn]);

export const ShareUrn = z
  .string()
  .regex(/^urn:li:(share|ugcPost):[0-9]+$/, 'must be a share or ugcPost URN');

export const ImageUrn = z
  .string()
  .regex(/^urn:li:image:[A-Za-z0-9_-]+$/, 'must be an image URN');

/** A comment on a post. Returned by socialActions, needed to reply. */
export const CommentUrn = z
  .string()
  .regex(
    /^urn:li:comment:\(urn:li:(share|ugcPost|activity):[0-9]+,[0-9]+\)$/,
    'must be a urn:li:comment URN',
  );

export type MemberUrn = z.infer<typeof MemberUrn>;
export type OrganizationUrn = z.infer<typeof OrganizationUrn>;
export type AuthorUrn = z.infer<typeof AuthorUrn>;
export type ShareUrn = z.infer<typeof ShareUrn>;
export type ImageUrn = z.infer<typeof ImageUrn>;
export type CommentUrn = z.infer<typeof CommentUrn>;

export function isOrganizationUrn(urn: string): urn is OrganizationUrn {
  return OrganizationUrn.safeParse(urn).success;
}

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
  author: AuthorUrn,
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

// --- Organizations (v2, Community Management API) ---------------------------

/**
 * GET /rest/organizationAcls?q=roleAssignee — the orgs this member administers.
 *
 * Requires `r_organization_social` (Community Management API). This is how the
 * setup wizard discovers pages rather than asking the founder to paste URNs.
 */
export const OrganizationAcl = z.object({
  elements: z
    .array(
      z.object({
        organization: OrganizationUrn,
        role: z.string(),
        /** APPROVED | REQUESTED | REJECTED. Only APPROVED can publish. */
        state: z.string(),
      }),
    )
    .default([]),
});
export type OrganizationAcl = z.infer<typeof OrganizationAcl>;

// --- Comments (v2, socialActions) -------------------------------------------

/**
 * One comment from GET /rest/socialActions/{shareUrn}/comments.
 *
 * `actor` may be a person or an organization. `parentComment` is present on
 * replies, absent on top-level comments — the engagement loop uses that to
 * avoid treating its own reply as a new inbound comment.
 */
export const Comment = z.object({
  /** urn:li:comment:(urn:li:share:123,456) */
  urn: CommentUrn,
  actor: z.string(),
  message: z.object({ text: z.string() }),
  /** Epoch milliseconds. */
  created: z.object({ time: z.number().int() }),
  parentComment: CommentUrn.optional(),
});
export type Comment = z.infer<typeof Comment>;

export const CommentsResponse = z.object({
  elements: z.array(Comment).default([]),
  paging: z
    .object({ start: z.number().int().optional(), count: z.number().int().optional() })
    .optional(),
});
export type CommentsResponse = z.infer<typeof CommentsResponse>;

// --- Analytics (v2, Community Management API) -------------------------------

/**
 * GET /rest/organizationalEntityShareStatistics
 *
 * Every field optional: LinkedIn omits metrics rather than zeroing them when a
 * post is too new or too low-volume to report. Storing a null is honest;
 * coercing to 0 would poison the learning loop's averages.
 */
export const ShareStatistics = z.object({
  elements: z
    .array(
      z.object({
        share: ShareUrn.optional(),
        totalShareStatistics: z
          .object({
            impressionCount: z.number().int().optional(),
            uniqueImpressionsCount: z.number().int().optional(),
            clickCount: z.number().int().optional(),
            likeCount: z.number().int().optional(),
            commentCount: z.number().int().optional(),
            shareCount: z.number().int().optional(),
            engagement: z.number().optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});
export type ShareStatistics = z.infer<typeof ShareStatistics>;
