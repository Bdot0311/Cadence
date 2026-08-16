import { LinkedInError } from './errors.js';
import type { LinkedInHttp } from './http.js';
import {
  CreatePostRequest,
  type CreatePostResult,
  ShareUrn,
  type ImageUrn,
  type MemberUrn,
  type PostVisibility,
} from './types.js';

/**
 * Publishing to the founder's personal profile via POST /rest/posts.
 *
 * This class is the entire write surface of the package. There is no method
 * that takes an organization URN, no message method, and no comment method —
 * the v1 scope is enforced by what exists here, not by a runtime flag someone
 * can flip. See LIMITS.md.
 */
export class Posts {
  constructor(private readonly http: LinkedInHttp) {}

  async create(args: {
    accountId: string;
    accessToken: string;
    author: MemberUrn;
    commentary: string;
    visibility?: PostVisibility;
    media?: ImageUrn[];
    mediaTitle?: string;
  }): Promise<CreatePostResult> {
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
      // Whether other members may reply. Comments stay open; the agent can't
      // read or reply to them in v1, but closing them would suppress the
      // comment-gate CTA the content engine is built around.
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
