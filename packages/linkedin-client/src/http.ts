import { LinkedInError } from './errors.js';
import type { LedgerSink, QuotaSnapshot, WriteGuard } from './types.js';

const REST_BASE = 'https://api.linkedin.com/rest';
const OAUTH_BASE = 'https://www.linkedin.com/oauth/v2';
const V2_BASE = 'https://api.linkedin.com/v2';

export interface HttpConfig {
  /** LinkedIn-Version header, YYYYMM. Sent on every /rest call. */
  apiVersion: string;
  ledger: LedgerSink;
  guard: WriteGuard;
  /** Retry attempts for retryable failures. 0 disables retrying. */
  maxRetries?: number;
  /** Base for exponential backoff, milliseconds. */
  baseBackoffMs?: number;
  /** Ceiling on any single backoff wait, milliseconds. */
  maxBackoffMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so a forced-throttle test doesn't actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable for tests. Defaults to Math.random. */
  randomImpl?: () => number;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT';
  /** Path relative to the chosen base, e.g. '/posts'. */
  path: string;
  base?: 'rest' | 'oauth' | 'v2';
  accessToken?: string;
  body?: unknown;
  /** Raw bytes, for media upload PUTs. Mutually exclusive with `body`. */
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
  /**
   * Whether this call counts against the daily write budget. Writes are gated
   * pre-flight and recorded with is_write = true.
   */
  isWrite?: boolean;
  /** Required when isWrite is true — the guard and ledger key off it. */
  accountId?: string | null;
  /** Absolute URL, overriding base + path. Used for media upload URLs. */
  absoluteUrl?: string;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
  quota: QuotaSnapshot;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Parse LinkedIn's quota headers off a response.
 *
 * Every field is optional because LinkedIn is inconsistent about which
 * endpoints send which headers. We record nulls rather than inferring — the
 * ledger's job is to say what LinkedIn actually told us.
 */
export function parseQuota(headers: Headers): QuotaSnapshot {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const resetRaw = num('x-ratelimit-reset');

  return {
    remaining: num('x-ratelimit-remaining'),
    limit: num('x-ratelimit-limit'),
    // LinkedIn sends this as a unix epoch in seconds when it sends it at all.
    resetAt: resetRaw === null ? null : new Date(resetRaw * 1000),
    retryAfterSeconds: num('retry-after'),
  };
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter (random between 0 and the computed ceiling) rather than
 * equal jitter, because the alternative — every retry clustering at the same
 * offset — is what turns one throttled account into a thundering herd when
 * several posts are due in the same tick.
 *
 * `Retry-After` always wins when LinkedIn sends it. Guessing against an
 * explicit instruction from the server is how you get a longer ban.
 */
export function backoffMs(
  attempt: number,
  quota: QuotaSnapshot,
  opts: { base: number; max: number; random: () => number },
): number {
  if (quota.retryAfterSeconds !== null && quota.retryAfterSeconds > 0) {
    return Math.min(quota.retryAfterSeconds * 1000, opts.max);
  }
  const ceiling = Math.min(opts.base * 2 ** attempt, opts.max);
  return Math.floor(opts.random() * ceiling);
}

export class LinkedInHttp {
  private readonly cfg: Required<
    Omit<HttpConfig, 'ledger' | 'guard' | 'apiVersion'>
  > &
    Pick<HttpConfig, 'ledger' | 'guard' | 'apiVersion'>;

  constructor(config: HttpConfig) {
    this.cfg = {
      apiVersion: config.apiVersion,
      ledger: config.ledger,
      guard: config.guard,
      maxRetries: config.maxRetries ?? 4,
      baseBackoffMs: config.baseBackoffMs ?? 1_000,
      maxBackoffMs: config.maxBackoffMs ?? 60_000,
      fetchImpl: config.fetchImpl ?? fetch,
      sleepImpl: config.sleepImpl ?? defaultSleep,
      randomImpl: config.randomImpl ?? Math.random,
    };
  }

  async request(opts: RequestOptions): Promise<RawResponse> {
    const isWrite = opts.isWrite ?? false;

    // Pre-flight. A blocked write never reaches the network, so it costs no
    // quota and leaves no ledger row — we didn't call LinkedIn.
    if (isWrite) {
      if (!opts.accountId) {
        throw new Error('accountId is required for write requests');
      }
      await this.cfg.guard.assertCanWrite(opts.accountId);
    }

    let lastError: LinkedInError | undefined;

    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      const started = Date.now();
      let res: RawResponse;

      try {
        res = await this.send(opts);
      } catch (cause) {
        // Network-level failure: no response, no quota headers.
        const err = new LinkedInError(
          `Network failure calling ${opts.path}: ${String(cause)}`,
          { endpoint: opts.path },
        );
        await this.cfg.ledger.record({
          accountId: opts.accountId ?? null,
          endpoint: opts.path,
          method: opts.method,
          responseCode: null,
          quota: emptyQuota(),
          isWrite,
          durationMs: Date.now() - started,
          errorBody: String(cause),
        });
        lastError = err;
        if (attempt === this.cfg.maxRetries) break;
        await this.cfg.sleepImpl(
          backoffMs(attempt, emptyQuota(), {
            base: this.cfg.baseBackoffMs,
            max: this.cfg.maxBackoffMs,
            random: this.cfg.randomImpl,
          }),
        );
        continue;
      }

      const durationMs = Date.now() - started;
      const ok = res.status >= 200 && res.status < 300;

      // Ledger every attempt, success or failure. A retry that eventually
      // succeeded still consumed quota, and the anomaly detector needs to see
      // the failures that preceded it.
      await this.cfg.ledger.record({
        accountId: opts.accountId ?? null,
        endpoint: opts.path,
        method: opts.method,
        responseCode: res.status,
        quota: res.quota,
        isWrite,
        durationMs,
        errorBody: ok ? null : truncate(res.text, 2000),
      });

      if (ok) return res;

      const err = new LinkedInError(
        `LinkedIn ${opts.method} ${opts.path} failed with ${res.status}`,
        { status: res.status, endpoint: opts.path, body: truncate(res.text, 2000) },
      );

      // 401/403 mean something structural broke. Stop immediately and let the
      // anomaly halt fire — retrying cannot fix a revoked token.
      if (err.fatal) throw err;

      if (res.status === 429 || res.status === 503) {
        if (opts.accountId) {
          await this.cfg.guard.onRateLimited(opts.accountId, res.quota);
        }
      }

      if (!err.retryable) throw err;

      lastError = err;
      if (attempt === this.cfg.maxRetries) break;

      await this.cfg.sleepImpl(
        backoffMs(attempt, res.quota, {
          base: this.cfg.baseBackoffMs,
          max: this.cfg.maxBackoffMs,
          random: this.cfg.randomImpl,
        }),
      );
    }

    throw (
      lastError ??
      new LinkedInError(`Exhausted retries calling ${opts.path}`, {
        endpoint: opts.path,
      })
    );
  }

  private async send(opts: RequestOptions): Promise<RawResponse> {
    const url = opts.absoluteUrl ?? baseUrl(opts.base ?? 'rest') + opts.path;

    const headers: Record<string, string> = {
      ...(opts.headers ?? {}),
    };

    if (opts.accessToken) {
      headers['Authorization'] = `Bearer ${opts.accessToken}`;
    }

    // Version + protocol headers belong on /rest only. Sending them to the
    // OAuth host is harmless but noisy; sending the wrong version is not.
    if ((opts.base ?? 'rest') === 'rest') {
      headers['LinkedIn-Version'] = this.cfg.apiVersion;
      headers['X-Restli-Protocol-Version'] = '2.0.0';
    }

    // Only ever a JSON string or raw bytes — no streams, no FormData.
    let body: string | Uint8Array | undefined;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    const response = await this.cfg.fetchImpl(url, {
      method: opts.method,
      headers,
      ...(body === undefined ? {} : { body }),
    } as RequestInit);

    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
      quota: parseQuota(response.headers),
    };
  }
}

function baseUrl(base: 'rest' | 'oauth' | 'v2'): string {
  switch (base) {
    case 'rest':
      return REST_BASE;
    case 'oauth':
      return OAUTH_BASE;
    case 'v2':
      return V2_BASE;
  }
}

function emptyQuota(): QuotaSnapshot {
  return { remaining: null, limit: null, resetAt: null, retryAfterSeconds: null };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[truncated]`;
}
