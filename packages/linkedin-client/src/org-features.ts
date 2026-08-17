/**
 * The gate for everything that needs Community Management API approval.
 *
 * Org publishing, comment reading, comment replies, webhooks, and org analytics
 * all sit behind this. Two conditions, both required:
 *
 *   1. `ORG_FEATURES_ENABLED` is on — the operator has deliberately turned it on
 *   2. The token actually carries the scope the call needs
 *
 * Condition 2 is the one that matters. A flag alone would let someone flip a
 * switch and start firing requests that come back 403, which trips the anomaly
 * halt and stops the whole agent — a config mistake taking down publishing that
 * was working fine. Checking the granted scope turns that into a clear local
 * error before anything leaves the process.
 *
 * Scopes are recorded on the account at OAuth time. Adding a product in the
 * LinkedIn developer console does NOT upgrade an existing token; the founder
 * has to re-run the OAuth flow. That is the single most common reason this
 * gate stays closed after approval lands, so the error message says so.
 */

export const ORG_SCOPES = {
  /** Publish as an organization. */
  write: 'w_organization_social',
  /** Read comments, reactions, analytics, and the org ACL. */
  read: 'r_organization_social',
} as const;

export type OrgScope = (typeof ORG_SCOPES)[keyof typeof ORG_SCOPES];

export class OrgFeaturesDisabledError extends Error {
  constructor(
    readonly capability: string,
    readonly reason: 'flag-off' | 'scope-missing',
    readonly requiredScope: OrgScope,
  ) {
    super(
      reason === 'flag-off'
        ? `${capability} requires organization features, which are disabled. ` +
            `Set ORG_FEATURES_ENABLED=true once Community Management API access is granted.`
        : `${capability} requires the "${requiredScope}" scope, which this token does not carry. ` +
            `Adding the product in the LinkedIn developer console does not upgrade an existing ` +
            `token — reconnect the account to re-run the OAuth flow with the new scope.`,
    );
    this.name = 'OrgFeaturesDisabledError';
  }
}

export interface OrgFeatureContext {
  /** ORG_FEATURES_ENABLED. */
  enabled: boolean;
  /** Scopes actually granted on this account's token, from `accounts.scopes`. */
  grantedScopes: readonly string[];
}

/**
 * Throws unless the capability is both enabled and scoped. Call at the top of
 * every org-gated method, before any request is built.
 */
export function assertOrgFeaturesEnabled(
  ctx: OrgFeatureContext,
  capability: string,
  requiredScope: OrgScope,
): void {
  if (!ctx.enabled) {
    throw new OrgFeaturesDisabledError(capability, 'flag-off', requiredScope);
  }
  if (!ctx.grantedScopes.includes(requiredScope)) {
    throw new OrgFeaturesDisabledError(capability, 'scope-missing', requiredScope);
  }
}

/** Non-throwing form, for the dashboard deciding what to render. */
export function orgFeaturesAvailable(
  ctx: OrgFeatureContext,
  requiredScope: OrgScope,
): boolean {
  return ctx.enabled && ctx.grantedScopes.includes(requiredScope);
}
