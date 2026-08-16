import { describe, expect, it, vi } from 'vitest';
import { LinkedInHttp, backoffMs, parseQuota } from './http.js';
import { BudgetExceededError, LinkedInError, WritesHaltedError } from './errors.js';
import type { LedgerEntry, LedgerSink, QuotaSnapshot, WriteGuard } from './types.js';

// --- test doubles -----------------------------------------------------------

class RecordingLedger implements LedgerSink {
  entries: LedgerEntry[] = [];
  async record(entry: LedgerEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class TestGuard implements WriteGuard {
  rateLimitTrips: Array<{ accountId: string; quota: QuotaSnapshot }> = [];
  blockWith: Error | null = null;

  async assertCanWrite(): Promise<void> {
    if (this.blockWith) throw this.blockWith;
  }
  async onRateLimited(accountId: string, quota: QuotaSnapshot): Promise<void> {
    this.rateLimitTrips.push({ accountId, quota });
  }
}

function res(
  status: number,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Response {
  return new Response(opts.body ?? '', {
    status,
    headers: opts.headers ?? {},
  });
}

function harness(responses: Response[], guard = new TestGuard()) {
  const ledger = new RecordingLedger();
  const sleeps: number[] = [];
  let i = 0;

  const http = new LinkedInHttp({
    apiVersion: '202608',
    ledger,
    guard,
    baseBackoffMs: 1000,
    maxBackoffMs: 60_000,
    fetchImpl: (async () => {
      const r = responses[i++];
      if (!r) throw new Error('fetch called more times than responses provided');
      return r;
    }) as unknown as typeof fetch,
    // Record the wait instead of actually sleeping, so a backoff test finishes
    // in milliseconds rather than minutes.
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
    // Deterministic jitter: always the top of the range.
    randomImpl: () => 1,
  });

  return { http, ledger, guard, sleeps };
}

// --- quota parsing ----------------------------------------------------------

describe('parseQuota', () => {
  it('parses the headers LinkedIn sends', () => {
    const q = parseQuota(
      new Headers({
        'x-ratelimit-remaining': '37',
        'x-ratelimit-limit': '100',
        'x-ratelimit-reset': '1755300000',
        'retry-after': '30',
      }),
    );
    expect(q.remaining).toBe(37);
    expect(q.limit).toBe(100);
    expect(q.resetAt?.toISOString()).toBe('2025-08-15T23:20:00.000Z');
    expect(q.retryAfterSeconds).toBe(30);
  });

  it('records nulls rather than guessing when headers are absent', () => {
    const q = parseQuota(new Headers({}));
    expect(q).toEqual({
      remaining: null,
      limit: null,
      resetAt: null,
      retryAfterSeconds: null,
    });
  });
});

// --- backoff ----------------------------------------------------------------

describe('backoffMs', () => {
  const opts = { base: 1000, max: 60_000, random: () => 1 };

  it('grows exponentially', () => {
    expect(backoffMs(0, empty(), opts)).toBe(1000);
    expect(backoffMs(1, empty(), opts)).toBe(2000);
    expect(backoffMs(2, empty(), opts)).toBe(4000);
    expect(backoffMs(3, empty(), opts)).toBe(8000);
  });

  it('caps at maxBackoffMs', () => {
    expect(backoffMs(20, empty(), opts)).toBe(60_000);
  });

  it('applies full jitter across the range', () => {
    const low = backoffMs(3, empty(), { ...opts, random: () => 0 });
    const high = backoffMs(3, empty(), { ...opts, random: () => 1 });
    expect(low).toBe(0);
    expect(high).toBe(8000);
  });

  it('honours Retry-After over its own computation', () => {
    const q = { ...empty(), retryAfterSeconds: 45 };
    // Attempt 0 would otherwise be ~1s. The server said 45s, so 45s it is.
    expect(backoffMs(0, q, opts)).toBe(45_000);
  });

  it('still caps a Retry-After that exceeds maxBackoffMs', () => {
    const q = { ...empty(), retryAfterSeconds: 3600 };
    expect(backoffMs(0, q, opts)).toBe(60_000);
  });

  function empty(): QuotaSnapshot {
    return { remaining: null, limit: null, resetAt: null, retryAfterSeconds: null };
  }
});

// --- throttle behaviour (acceptance criterion 4) ----------------------------

describe('forced throttle', () => {
  it('backs off and retries a 429, then succeeds', async () => {
    const { http, sleeps, guard, ledger } = harness([
      res(429, { headers: { 'retry-after': '2' } }),
      res(429, { headers: { 'retry-after': '4' } }),
      res(201, { headers: { 'x-restli-id': 'urn:li:share:123' } }),
    ]);

    const out = await http.request({
      method: 'POST',
      path: '/posts',
      accountId: 'acct-1',
      isWrite: true,
      body: {},
    });

    expect(out.status).toBe(201);
    expect(sleeps).toEqual([2000, 4000]);
    // Every attempt is ledgered, not just the one that worked.
    expect(ledger.entries.map((e) => e.responseCode)).toEqual([429, 429, 201]);
    // The guard heard about both trips and can apply the twice-in-an-hour rule.
    expect(guard.rateLimitTrips).toHaveLength(2);
    expect(guard.rateLimitTrips[0]?.accountId).toBe('acct-1');
  });

  it('notifies the guard on 503 as well as 429', async () => {
    const { http, guard } = harness([res(503), res(200)]);
    await http.request({
      method: 'POST',
      path: '/posts',
      accountId: 'acct-1',
      isWrite: true,
    });
    expect(guard.rateLimitTrips).toHaveLength(1);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const { http } = harness([res(429), res(429), res(429), res(429), res(429)]);
    await expect(
      http.request({
        method: 'POST',
        path: '/posts',
        accountId: 'acct-1',
        isWrite: true,
      }),
    ).rejects.toThrow(LinkedInError);
  });
});

// --- fatal errors halt rather than retry ------------------------------------

describe('fatal errors', () => {
  it.each([401, 403])(
    'throws immediately on %i without retrying',
    async (status) => {
      const { http, sleeps, ledger } = harness([res(status, { body: 'nope' })]);

      const err = await http
        .request({
          method: 'POST',
          path: '/posts',
          accountId: 'acct-1',
          isWrite: true,
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LinkedInError);
      expect((err as LinkedInError).fatal).toBe(true);
      expect((err as LinkedInError).retryable).toBe(false);
      // No backoff, no second attempt. Retrying a revoked token is pointless
      // and hides the real failure behind a backoff curve.
      expect(sleeps).toEqual([]);
      expect(ledger.entries).toHaveLength(1);
    },
  );
});

// --- pre-flight gating ------------------------------------------------------

describe('write guard', () => {
  it('blocks the request before it reaches the network when over budget', async () => {
    const guard = new TestGuard();
    guard.blockWith = new BudgetExceededError('acct-1', 80, 80);
    const { http, ledger } = harness([], guard);

    await expect(
      http.request({
        method: 'POST',
        path: '/posts',
        accountId: 'acct-1',
        isWrite: true,
      }),
    ).rejects.toThrow(BudgetExceededError);

    // Nothing was sent, so nothing is ledgered — we didn't call LinkedIn.
    expect(ledger.entries).toEqual([]);
  });

  it('blocks when writes are halted (kill switch / paused account)', async () => {
    const guard = new TestGuard();
    guard.blockWith = new WritesHaltedError('kill switch engaged');
    const { http, ledger } = harness([], guard);

    await expect(
      http.request({
        method: 'POST',
        path: '/posts',
        accountId: 'acct-1',
        isWrite: true,
      }),
    ).rejects.toThrow(WritesHaltedError);
    expect(ledger.entries).toEqual([]);
  });

  it('does not gate reads', async () => {
    const guard = new TestGuard();
    guard.blockWith = new WritesHaltedError('kill switch engaged');
    const { http } = harness([res(200, { body: '{}' })], guard);

    const out = await http.request({ method: 'GET', path: '/userinfo', base: 'v2' });
    expect(out.status).toBe(200);
  });

  it('refuses a write with no accountId rather than skipping the gate', async () => {
    const { http } = harness([res(201)]);
    await expect(
      http.request({ method: 'POST', path: '/posts', isWrite: true }),
    ).rejects.toThrow(/accountId is required/);
  });
});

// --- version pinning --------------------------------------------------------

describe('headers', () => {
  it('sends LinkedIn-Version and the restli protocol header on /rest calls', async () => {
    const seen: Array<Record<string, string>> = [];
    const http = new LinkedInHttp({
      apiVersion: '202608',
      ledger: new RecordingLedger(),
      guard: new TestGuard(),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>);
        return res(200, { body: '{}' });
      }) as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    await http.request({ method: 'GET', path: '/posts', accessToken: 'tok' });

    expect(seen[0]?.['LinkedIn-Version']).toBe('202608');
    expect(seen[0]?.['X-Restli-Protocol-Version']).toBe('2.0.0');
    expect(seen[0]?.['Authorization']).toBe('Bearer tok');
  });

  it('omits the version header on the OAuth host', async () => {
    const seen: Array<Record<string, string>> = [];
    const http = new LinkedInHttp({
      apiVersion: '202608',
      ledger: new RecordingLedger(),
      guard: new TestGuard(),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>);
        return res(200, { body: '{}' });
      }) as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    await http.request({ method: 'POST', path: '/accessToken', base: 'oauth' });
    expect(seen[0]?.['LinkedIn-Version']).toBeUndefined();
  });
});
