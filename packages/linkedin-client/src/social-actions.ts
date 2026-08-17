import { LinkedInError } from './errors.js';
import type { LinkedInHttp } from './http.js';
import {
  ORG_SCOPES,
  assertOrgFeaturesEnabled,
  type OrgFeatureContext,
} from './org-features.js';
import {
  Comment,
  CommentsResponse,
  CommentUrn,
  type AuthorUrn,
  type ShareUrn,
} from './types.js';

/**
 * Comments on posts we authored, via the socialActions surface.
 *
 * SCOPE OF WHAT IS POSSIBLE HERE — read this before adding a method.
 *
 * socialActions only reaches content our own authenticated entities authored.
 * There is no method here to comment on someone else's post, read the feed, or
 * look up a member, because those endpoints do not exist at any tier we can
 * self-serve. See LIMITS.md. The absence is the design.
 *
 * Everything on this class is gated on Community Management API approval.
 */
export class SocialActions {
  constructor(
    private readonly http: LinkedInHttp,
    private readonly ctx: OrgFeatureContext,
  ) {}

  /**
   * Comments on one of our posts, newest first.
   *
   * Replies (comments carrying `parentComment`) come back in the same list as
   * top-level comments. The engagement loop filters them out so it does not
   * treat its own reply as a new inbound comment and answer itself.
   */
  async listComments(args: {
    accountId: string;
    accessToken: string;
    shareUrn: ShareUrn;
    count?: number;
  }): Promise<Comment[]> {
    assertOrgFeaturesEnabled(this.ctx, 'Reading comments', ORG_SCOPES.read);

    const encoded = encodeURIComponent(args.shareUrn);
    const res = await this.http.request({
      method: 'GET',
      path: `/socialActions/${encoded}/comments?count=${args.count ?? 50}`,
      accessToken: args.accessToken,
      accountId: args.accountId,
      isWrite: false,
    });

    const parsed = CommentsResponse.safeParse(safeJson(res.text));
    if (!parsed.success) {
      throw new LinkedInError(
        `Unrecognised comments response: ${parsed.error.message}`,
        { status: res.status, endpoint: '/socialActions/comments', body: res.text },
      );
    }
    return parsed.data.elements;
  }

  /**
   * Reply to a comment on one of our posts.
   *
   * `parentComment` is what makes this a threaded reply rather than a new
   * top-level comment on the post. Omitting it would post a detached comment
   * that reads as the account talking to itself.
   */
  async replyToComment(args: {
    accountId: string;
    accessToken: string;
    shareUrn: ShareUrn;
    parentComment: CommentUrn;
    actor: AuthorUrn;
    text: string;
  }): Promise<{ urn: CommentUrn }> {
    assertOrgFeaturesEnabled(this.ctx, 'Replying to comments', ORG_SCOPES.write);

    const parent = CommentUrn.parse(args.parentComment);
    const encoded = encodeURIComponent(args.shareUrn);

    const res = await this.http.request({
      method: 'POST',
      path: `/socialActions/${encoded}/comments`,
      accessToken: args.accessToken,
      accountId: args.accountId,
      // Counts against the daily write budget. A chatty engagement loop and a
      // publishing schedule draw on the same quota, which is exactly why they
      // share one ledger.
      isWrite: true,
      body: {
        actor: args.actor,
        object: args.shareUrn,
        message: { text: args.text },
        parentComment: parent,
      },
    });

    const urn = res.headers.get('x-restli-id');
    if (!urn) {
      throw new LinkedInError(
        'Comment reply succeeded but returned no x-restli-id header. The reply ' +
          'may have posted — check the thread before retrying, or the account ' +
          'will reply twice.',
        { status: res.status, endpoint: '/socialActions/comments', body: res.text },
      );
    }

    return { urn: CommentUrn.parse(urn) };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
