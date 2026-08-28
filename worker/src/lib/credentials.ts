/**
 * Per-owner credential resolution.
 *
 * The security property this file exists to guarantee: an account's work is
 * only ever performed with ITS OWN owner's credentials. Before this, the worker
 * built one ModelClient and one LinkedInClient at boot from process env, so
 * every account in a shared deployment ran on whichever keys were saved last.
 *
 * Env values remain as a FALLBACK, not a default. That keeps a single-tenant
 * self-hosted install working with no database rows, while a shared deployment
 * with per-user rows never touches them. `source` is returned so callers can
 * log which path was taken rather than guessing.
 */

export interface OwnerCredentials {
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  linkedinClientId: string;
  linkedinClientSecret: string;
  source: 'per-user' | 'env-fallback' | 'mixed';
}

export interface StoredOwnerCredentials {
  anthropicApiKey: string | null;
  anthropicModel: string | null;
  anthropicEffort: string | null;
  linkedinClientId: string | null;
  linkedinClientSecret: string | null;
}

export interface EnvFallback {
  anthropicApiKey?: string | undefined;
  anthropicModel: string;
  anthropicEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  linkedinClientId?: string | undefined;
  linkedinClientSecret?: string | undefined;
  /**
   * When true, env values are NOT used for any owner that has a credentials
   * row. Set this on a shared deployment: falling back to the operator's own
   * keys for a user who half-configured theirs is exactly the bleed this
   * table exists to prevent.
   */
  multiTenant: boolean;
}

export class MissingCredentialsError extends Error {
  constructor(readonly ownerId: string, readonly missing: string[]) {
    super(
      `Owner ${ownerId} is missing credentials: ${missing.join(', ')}. ` +
        `The account will be skipped rather than run on another user's keys.`,
    );
    this.name = 'MissingCredentialsError';
  }
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
function effort(v: string | null, fallback: EnvFallback['anthropicEffort']) {
  return (EFFORTS as readonly string[]).includes(v ?? '')
    ? (v as EnvFallback['anthropicEffort'])
    : fallback;
}

/**
 * Resolve one owner's credentials, or throw.
 *
 * Throwing is deliberate. A worker that silently substitutes the operator's key
 * for a user who has not supplied one bills the wrong person and publishes from
 * the wrong LinkedIn app. Skipping the account is the safe failure.
 */
export function resolveCredentials(args: {
  ownerId: string;
  stored: StoredOwnerCredentials | null;
  env: EnvFallback;
}): OwnerCredentials {
  const { ownerId, stored, env } = args;
  const hasRow = stored !== null;

  // On a shared deployment the env is NEVER consulted. An owner who has not
  // configured their keys must be skipped, not silently run on the operator's
  // — that bills the wrong person and publishes from the wrong LinkedIn app.
  // Falling back only for owners with no row at all is the same bleed wearing
  // a narrower condition.
  const allowEnv = !env.multiTenant;

  const anthropicApiKey =
    stored?.anthropicApiKey ?? (allowEnv ? env.anthropicApiKey ?? null : null);
  const linkedinClientId =
    stored?.linkedinClientId ?? (allowEnv ? env.linkedinClientId ?? null : null);
  const linkedinClientSecret =
    stored?.linkedinClientSecret ?? (allowEnv ? env.linkedinClientSecret ?? null : null);

  // Collect every gap before throwing, so the operator sees all of them at
  // once rather than fixing one and rediscovering the next. The explicit
  // re-checks below are what let TypeScript narrow away the nulls; it cannot
  // follow the narrowing through the array length test.
  const missing: string[] = [];
  if (!anthropicApiKey) missing.push('anthropic_api_key');
  if (!linkedinClientId) missing.push('linkedin_client_id');
  if (!linkedinClientSecret) missing.push('linkedin_client_secret');
  if (!anthropicApiKey || !linkedinClientId || !linkedinClientSecret) {
    throw new MissingCredentialsError(ownerId, missing);
  }

  const fromStore =
    stored?.anthropicApiKey !== null &&
    stored?.anthropicApiKey !== undefined &&
    stored?.linkedinClientId !== null &&
    stored?.linkedinClientId !== undefined;
  const fromEnvOnly = !hasRow;

  return {
    anthropicApiKey,
    anthropicModel: stored?.anthropicModel ?? env.anthropicModel,
    anthropicEffort: effort(stored?.anthropicEffort ?? null, env.anthropicEffort),
    linkedinClientId,
    linkedinClientSecret,
    source: fromEnvOnly ? 'env-fallback' : fromStore ? 'per-user' : 'mixed',
  };
}
