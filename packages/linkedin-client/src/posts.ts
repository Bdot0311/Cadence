import { LinkedInError } from './errors.js';
import type { LinkedInHttp } from './http.js';
import {
  ORG_SCOPES,
  assertOrgFeaturesEnabled,
  type OrgFeatureContext,
} from './org-features.js';
import {
  CreatePostRequest,
  isOrganizationUrn,
  type AuthorUrn,
  type CreatePostResult,
  ShareUrn,
  type ImageUrn,
  type PostVisibility,
} from './types.js';

/**
 * Publishing via POST /rest/posts.
 *
 * Authoring as a MEMBER needs only `w_member_social`, a self-serve Open
 * Permission. Authoring as an ORGANIZATION needs `w_organization_social` from
 * Community Management API, so it is gated — see the check in `create`.
 *
 * There is still no message method and no method for commenting on someone
 * else's post, because those endpoints do not exist at any tier we can
 * self-serve. See LIMITS.md.
 */
export class Posts {
  constructor(
    private readonly http: LinkedInHttp,
    /**
     * Optional. Omit it and member publishing works exactly as before, while
     * any attempt to author as an organization fails closed.
     */
    private readonly orgCtx: OrgFeatureContext = {
      enabled: false,
      grantedScopes: [],
    },
  ) {}

  async create(args: {
    accountId: string;
    accessToken: string;
    author: AuthorUrn;
    commentary: string;
    visibility?: PostVisibility;
    media?: ImageUrn[];
    mediaTitle?: string;
  }): Promise<CreatePostResult> {
    // Gate on the URN itself rather than on a caller-supplied flag. A page post
    // cannot reach the network without the scope, however it was routed here.
    if (isOrganizationUrn(args.author)) {
      assertOrgFeaturesEnabled(
        this.orgCtx,
        'Publishing to a company page',
        ORG_SCOPES.write,
      );
    }

    const input = CreatePostRequest.parse({
      author: args.author,
      commentary: args.commentary,
      visibility: args.visibility ?? 'PUBLIC',
      media: args.media ?? [],
      ...(args.mediaTitle === undefined ? {} : { mediaTitle: args.mediaTitle }),
    });

    const body: Record<string, unknown> = {
      author: input.author,
      commentary: input.commentary,
      visibility: input.visibility,
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      // Whether other members may reshare. Comments stay open regardless —
      // closing them would suppress the comment-gate CTA the content engine is
      // built around.
      isReshareDisabledByAuthor: false,
    };

    if (input.media.length === 1) {
      body['content'] = {
        media: {
          id: input.media[0],
          ...(input.mediaTitle === undefined ? {} : { title: input.mediaTitle }),
        },
      };
    } else if (input.media.length > 1) {
      body['content'] = {
        multiImage: {
          images: input.media.map((id) => ({ id })),
          ...(input.mediaTitle === undefined ? {} : { title: input.mediaTitle }),
        },
      };
    }

    const res = await this.http.request({
      method: 'POST',
      path: '/posts',
      accessToken: args.accessToken,
      accountId: args.accountId,
      isWrite: true,
      body,
    });

    // 201 Created with an empty body — the URN comes back in a header.
    // Missing it is a hard error: a post we can't identify is a post we can't
    // measure, dedupe against, or reference later.
    const urn = res.headers.get('x-restli-id');
    if (!urn) {
      throw new LinkedInError(
        'POST /rest/posts succeeded but returned no x-restli-id header. ' +
          'The post may have published — check the profile before retrying.',
        { status: res.status, endpoint: '/posts', body: res.text },
      );
    }

    return { urn: ShareUrn.parse(urn) };
  }
}
