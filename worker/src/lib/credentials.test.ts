import { describe, expect, it } from 'vitest';
import {
  MissingCredentialsError,
  resolveCredentials,
  type EnvFallback,
  type StoredOwnerCredentials,
} from './credentials.js';

const env: EnvFallback = {
  anthropicApiKey: 'sk-operator-key',
  anthropicModel: 'claude-sonnet-5',
  anthropicEffort: 'high',
  linkedinClientId: 'operator-app',
  linkedinClientSecret: 'operator-secret',
  multiTenant: false,
};

const stored: StoredOwnerCredentials = {
  anthropicApiKey: 'sk-user-key',
  anthropicModel: 'claude-opus-5',
  anthropicEffort: 'max',
  linkedinClientId: 'user-app',
  linkedinClientSecret: 'user-secret',
};

describe('per-owner isolation', () => {
  it('uses the owner\'s own credentials when present', () => {
    const c = resolveCredentials({ ownerId: 'u1', stored, env });
    expect(c.anthropicApiKey).toBe('sk-user-key');
    expect(c.linkedinClientId).toBe('user-app');
    expect(c.anthropicModel).toBe('claude-opus-5');
    expect(c.source).toBe('per-user');
  });

  /**
   * The bleed this whole table exists to prevent: user B's account must never
   * run on user A's key just because A configured theirs first.
   */
  it('never substitutes the operator key for a half-configured user in multi-tenant mode', () => {
    const partial: StoredOwnerCredentials = {
      ...stored, anthropicApiKey: null,
    };
    const err = grab(() =>
      resolveCredentials({
        ownerId: 'u2',
        stored: partial,
        env: { ...env, multiTenant: true },
      }),
    );
    expect(err).toBeInstanceOf(MissingCredentialsError);
    expect((err as MissingCredentialsError).missing).toEqual(['anthropic_api_key']);
  });

  it('skips the account rather than running it on nothing', () => {
    const err = grab(() =>
      resolveCredentials({
        ownerId: 'u3',
        stored: null,
        env: { ...env, multiTenant: true },
      }),
    );
    expect(err).toBeInstanceOf(MissingCredentialsError);
    expect(err.message).toMatch(/rather than run on another user's keys/);
  });

  it('keeps a single-tenant self-host working with no rows at all', () => {
    const c = resolveCredentials({ ownerId: 'u4', stored: null, env });
    expect(c.anthropicApiKey).toBe('sk-operator-key');
    expect(c.source).toBe('env-fallback');
  });

  it('reports mixed when a row exists but only partly fills the env gap', () => {
    const c = resolveCredentials({
      ownerId: 'u5',
      stored: { ...stored, anthropicApiKey: null },
      env,
    });
    // Single-tenant, so the env key is allowed to fill in.
    expect(c.anthropicApiKey).toBe('sk-operator-key');
    expect(c.source).toBe('mixed');
  });

  it('falls back to the env model and effort when the row does not set them', () => {
    const c = resolveCredentials({
      ownerId: 'u6',
      stored: { ...stored, anthropicModel: null, anthropicEffort: null },
      env,
    });
    expect(c.anthropicModel).toBe('claude-sonnet-5');
    expect(c.anthropicEffort).toBe('high');
  });

  it('rejects a nonsense effort value rather than passing it to the API', () => {
    const c = resolveCredentials({
      ownerId: 'u7',
      stored: { ...stored, anthropicEffort: 'ludicrous' },
      env,
    });
    expect(c.anthropicEffort).toBe('high');
  });

  it('does not leak one owner\'s values into another resolution', () => {
    const a = resolveCredentials({ ownerId: 'a', stored, env });
    const b = resolveCredentials({
      ownerId: 'b',
      stored: { ...stored, anthropicApiKey: 'sk-b', linkedinClientId: 'b-app' },
      env,
    });
    expect(a.anthropicApiKey).toBe('sk-user-key');
    expect(b.anthropicApiKey).toBe('sk-b');
    expect(b.linkedinClientId).toBe('b-app');
  });
});

function grab(fn: () => unknown): Error {
  try { fn(); } catch (e) { return e as Error; }
  throw new Error('expected a throw');
}
