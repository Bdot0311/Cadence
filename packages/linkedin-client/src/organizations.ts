import { LinkedInError } from './errors.js';
import type { LinkedInHttp } from './http.js';
import {
  ORG_SCOPES,
  assertOrgFeaturesEnabled,
  type OrgFeatureContext,
} from './org-features.js';
import {
  OrganizationAcl,
  ShareStatistics,
  type OrganizationUrn,
  type ShareUrn,
} from './types.js';

export interface AdministeredOrg {
  urn: OrganizationUrn;
  role: string;
  /** False when the ACL is REQUESTED or REJECTED rather than APPROVED. */
  canPublish: boolean;
}

/** Per-post metrics, shaped for the `performance` table. */
export interface PostMetrics {
  shareUrn: ShareUrn;
  impressions: number | null;
  uniqueImpressions: number | null;
  clicks: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  engagementRate: number | null;
}

/**
 * Organization discovery and analytics. Both need Community Management API.
 *
 * The analytics half is what finally gives the learning loop an automated
 * input. Until this is live, `performance` rows are entered by hand from
 * LinkedIn's own UI and carry `source = 'manual'`.
 */
export class Organizations {
  constructor(
    private readonly http: LinkedInHttp,
    private readonly ctx: OrgFeatureContext,
  ) {}

  /**
   * Every organization the authenticated member administers.
   *
   * This is what the setup wizard calls so the founder picks pages from a list
   * instead of hand-copying URNs out of LinkedIn URLs.
   */
  async listAdministered(args: {
    accountId: string;
    accessToken: string;
  }): Promise<AdministeredOrg[]> {
    assertOrgFeaturesEnabled(this.ctx, 'Organization discovery', ORG_SCOPES.read);

    const res = await this.http.request({
      method: 'GET',
      path: '/organizationAcls?q=roleAssignee&state=APPROVED',
      accessToken: args.accessToken,
      accountId: args.accountId,
      isWrite: false,
    });

    const parsed = OrganizationAcl.safeParse(safeJson(res.text));
    if (!parsed.success) {
      throw new LinkedInError(
        `Unrecognised organizationAcls response: ${parsed.error.message}`,
        { status: res.status, endpoint: '/organizationAcls', body: res.text },
      );
    }

    return parsed.data.elements.map((e) => ({
      urn: e.organization,
      role: e.role,
      // Filtering server-side by state=APPROVED already, but a pending ACL that
      // slips through must not be treated as publishable — a post to an org we
      // do not yet administer fails with a 403 and trips the anomaly halt.
      canPublish: e.state === 'APPROVED',
    }));
  }

  /**
   * Metrics for specific posts on an org page.
   *
   * Every field is nullable on purpose. LinkedIn omits metrics rather than
   * zeroing them when a post is too new or too low-volume to report, and
   * coercing a missing impression count to 0 would drag the learning loop's
   * per-pillar averages toward zero for exactly the posts it knows least about.
   */
  async shareStatistics(args: {
    accountId: string;
    accessToken: string;
    organization: OrganizationUrn;
    shares: ShareUrn[];
  }): Promise<PostMetrics[]> {
    assertOrgFeaturesEnabled(this.ctx, 'Organization analytics', ORG_SCOPES.read);
    if (args.shares.length === 0) return [];

    const params = new URLSearchParams({
      q: 'organizationalEntity',
      organizationalEntity: args.organization,
    });
    args.shares.forEach((s, i) => params.append(`shares[${i}]`, s));

    const res = await this.http.request({
      method: 'GET',
      path: `/organizationalEntityShareStatistics?${params.toString()}`,
      accessToken: args.accessToken,
      accountId: args.accountId,
      isWrite: false,
    });

    const parsed = ShareStatistics.safeParse(safeJson(res.text));
    if (!parsed.success) {
      throw new LinkedInError(
        `Unrecognised share statistics response: ${parsed.error.message}`,
        {
          status: res.status,
          endpoint: '/organizationalEntityShareStatistics',
          body: res.text,
        },
      );
    }

    return parsed.data.elements.flatMap((el) => {
      if (!el.share) return [];
      const s = el.totalShareStatistics;
      return [
        {
          shareUrn: el.share,
          impressions: s?.impressionCount ?? null,
          uniqueImpressions: s?.uniqueImpressionsCount ?? null,
          clicks: s?.clickCount ?? null,
          reactions: s?.likeCount ?? null,
          comments: s?.commentCount ?? null,
          shares: s?.shareCount ?? null,
          engagementRate: s?.engagement ?? null,
        },
      ];
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
