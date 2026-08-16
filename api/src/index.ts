import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { LinkedInClient, type LedgerEntry } from '@agent/linkedin-client';
import { z } from 'zod';

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  LINKEDIN_CLIENT_ID: z.string().min(1),
  LINKEDIN_CLIENT_SECRET: z.string().min(1),
  LINKEDIN_REDIRECT_URI: z.string().url(),
  LINKEDIN_API_VERSION: z.string().regex(/^\d{6}$/),
  LINKEDIN_SCOPES: z.string().default('openid profile email w_member_social'),
  API_PORT: z.coerce.number().int().positive().default(8080),
  DASHBOARD_URL: z.string().url().default('http://localhost:5173'),
  OAUTH_STATE_SECRET: z.string().min(32),
});

const env = Env.parse(process.env);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const linkedin = new LinkedInClient({
  apiVersion: env.LINKEDIN_API_VERSION,
  ledger: { record: (entry) => recordLedger(db, entry) },
  guard: {
    assertCanWrite: async () => undefined,
    onRateLimited: async () => undefined,
  },
  oauth: {
    clientId: env.LINKEDIN_CLIENT_ID,
    clientSecret: env.LINKEDIN_CLIENT_SECRET,
    redirectUri: env.LINKEDIN_REDIRECT_URI,
    scopes: env.LINKEDIN_SCOPES.split(/\s+/).filter(Boolean),
  },
});

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return send(res, 204, null);
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    const status = error instanceof ApiError ? error.status : 500;
    send(res, status, { error: error instanceof Error ? error.message : 'Unexpected error' });
  }
});

server.listen(env.API_PORT, () => {
  console.info(`Cadence API listening on http://localhost:${env.API_PORT}`);
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'cadence-api' });
  }

  if (req.method === 'GET' && url.pathname === '/auth/linkedin/callback') {
    const code = requiredQuery(url, 'code');
    const state = verifyState(requiredQuery(url, 'state'));
    const tokens = await linkedin.oauth.exchangeCode(code);
    const profile = await linkedin.oauth.fetchMemberUrn(tokens.accessToken);
    const { data, error } = await db.rpc('upsert_linkedin_account', {
      target_owner_id: state.ownerId,
      target_urn: profile.urn,
      target_display_name: profile.displayName,
      new_access_token: tokens.accessToken,
      new_refresh_token: tokens.refreshToken,
      new_token_expires_at: tokens.expiresAt.toISOString(),
      new_refresh_expires_at: tokens.refreshExpiresAt?.toISOString() ?? null,
      new_scopes: tokens.scopes,
    });
    throwDb(error);
    res.statusCode = 302;
    res.setHeader('Location', `${env.DASHBOARD_URL}/?connected=${encodeURIComponent(String(data))}`);
    res.end();
    return;
  }

  const user = await authenticate(req);

  if (req.method === 'POST' && url.pathname === '/auth/linkedin/start') {
    const state = signState({ ownerId: user.id, nonce: randomBytes(16).toString('hex'), exp: Date.now() + 10 * 60_000 });
    return send(res, 200, { url: linkedin.oauth.authorizationUrl(state) });
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    return send(res, 200, await dashboardPayload(user.id));
  }

  if (req.method === 'POST' && url.pathname === '/api/voice-profile') {
    const input = VoiceInput.parse(await body(req));
    const accountId = await requireOwnedAccount(user.id, input.accountId);
    const { data: latest, error: versionError } = await db.from('voice_profiles')
      .select('version').eq('account_id', accountId).order('version', { ascending: false }).limit(1);
    throwDb(versionError);
    const version = (latest?.[0]?.version ?? 0) + 1;
    const profile = analyseVoice(input.posts);
    const { error: deactivateError } = await db.from('voice_profiles').update({ active: false }).eq('account_id', accountId);
    throwDb(deactivateError);
    const { error } = await db.from('voice_profiles').insert({
      account_id: accountId, version, profile, source_posts: input.posts, active: true,
    });
    throwDb(error);
    return send(res, 201, { version, profile });
  }

  if (req.method === 'PUT' && url.pathname === '/api/pillars') {
    const input = PillarsInput.parse(await body(req));
    const accountId = await requireOwnedAccount(user.id, input.accountId);
    const total = input.pillars.reduce((sum, pillar) => sum + pillar.targetShare, 0);
    if (Math.abs(total - 1) > 0.001) throw new ApiError(400, 'Pillar target shares must total 1.0');
    const { error: clearError } = await db.from('content_pillars').update({ active: false }).eq('account_id', accountId);
    throwDb(clearError);
    for (const pillar of input.pillars) {
      const { error } = await db.from('content_pillars').upsert({
        account_id: accountId,
        name: pillar.name,
        description: pillar.description,
        target_share: pillar.targetShare,
        active: true,
      }, { onConflict: 'account_id,name' });
      throwDb(error);
    }
    return send(res, 200, { ok: true });
  }

  if (req.method === 'PUT' && url.pathname === '/api/config') {
    const input = ConfigInput.parse(await body(req));
    const accountId = await requireOwnedAccount(user.id, input.accountId);
    const { error } = await db.from('agent_config').update({
      timezone: input.timezone,
      schedule: {
        windows: input.windows,
        min_gap_minutes: input.minGapMinutes,
        daily_cap: input.dailyCap,
        weekly_cap: input.weeklyCap,
        jitter_minutes: input.jitterMinutes,
      },
      cta_policy: input.ctaPolicy,
      blocked_topics: input.blockedTopics,
      blocked_claims: input.blockedClaims,
      autonomy_mode: input.autonomyMode,
    }).eq('account_id', accountId);
    throwDb(error);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/kill-switch') {
    const input = KillSwitchInput.parse(await body(req));
    const accountId = await requireOwnedAccount(user.id, input.accountId);
    const { error } = await db.from('agent_config').update({
      kill_switch_engaged: input.engaged,
      halt_reason: input.engaged ? (input.reason ?? 'Engaged from dashboard') : null,
      halted_at: input.engaged ? new Date().toISOString() : null,
    }).eq('account_id', accountId);
    throwDb(error);
    return send(res, 200, { engaged: input.engaged });
  }

  if (req.method === 'POST' && url.pathname === '/api/posts') {
    const input = PostInput.parse(await body(req));
    const accountId = await requireOwnedAccount(user.id, input.accountId);
    const { data, error } = await db.from('post_queue').insert({
      account_id: accountId,
      pillar_id: input.pillarId,
      body: input.body,
      state: input.scheduledAt ? 'scheduled' : 'approved',
      scheduled_at: input.scheduledAt,
      prompt_version: 'dashboard-manual-v1',
      generation_params: { source: 'dashboard' },
    }).select('id').single();
    throwDb(error);
    return send(res, 201, data);
  }

  const postState = url.pathname.match(/^\/api\/posts\/([0-9a-f-]+)\/state$/i);
  if (req.method === 'PATCH' && postState) {
    const input = z.object({ state: z.enum(['approved', 'scheduled', 'killed']) }).parse(await body(req));
    const postId = postState[1] as string;
    const { data: post, error: postError } = await db.from('post_queue').select('account_id').eq('id', postId).single();
    throwDb(postError);
    if (!post) throw new ApiError(404, 'Post not found');
    await requireOwnedAccount(user.id, post.account_id);
    const { error } = await db.from('post_queue').update({ state: input.state }).eq('id', postId);
    throwDb(error);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/performance') {
    const input = PerformanceInput.parse(await body(req));
    const accountId = await requireOwnedAccount(user.id, input.accountId);
    const engagement = input.impressions > 0
      ? (input.reactions + input.comments + input.shares + input.clicks) / input.impressions : 0;
    const { error } = await db.from('performance').upsert({
      post_id: input.postId,
      account_id: accountId,
      source: 'manual',
      impressions: input.impressions,
      clicks: input.clicks,
      reactions: input.reactions,
      comments: input.comments,
      shares: input.shares,
      engagement_rate: engagement,
      hours_since_publish: input.hoursSincePublish,
    }, { onConflict: 'post_id,hours_since_publish' });
    throwDb(error);
    return send(res, 201, { engagementRate: engagement });
  }

  throw new ApiError(404, 'Not found');
}

async function dashboardPayload(ownerId: string): Promise<Record<string, unknown>> {
  const { data: accounts, error } = await db.from('accounts')
    .select('id,urn,display_name,active,paused_until,pause_reason,token_expires_at,refresh_expires_at,created_at,agent_config(*),content_pillars(*),voice_profiles(id,version,profile,active,created_at)')
    .eq('owner_id', ownerId).order('created_at', { ascending: true });
  throwDb(error);
  const ids = (accounts ?? []).map((account) => account.id);
  if (ids.length === 0) return { accounts: [], posts: [], logs: [], performance: [], stats: emptyStats() };
  const [posts, logs, performance, writes] = await Promise.all([
    db.from('post_queue').select('*,content_pillars(name)').in('account_id', ids).order('created_at', { ascending: false }).limit(100),
    db.from('agent_log').select('*').in('account_id', ids).order('created_at', { ascending: false }).limit(100),
    db.from('performance').select('*').in('account_id', ids).order('measured_at', { ascending: false }).limit(100),
    db.from('rate_ledger').select('response_code,is_write,created_at,quota_remaining').in('account_id', ids).gte('created_at', startOfUtcDay()),
  ]);
  for (const result of [posts, logs, performance, writes]) throwDb(result.error);
  const postRows = posts.data ?? [];
  const writeRows = writes.data ?? [];
  return {
    accounts,
    posts: postRows,
    logs: logs.data ?? [],
    performance: performance.data ?? [],
    stats: {
      published: postRows.filter((p) => p.state === 'published').length,
      queued: postRows.filter((p) => ['approved', 'scheduled'].includes(p.state)).length,
      killed: postRows.filter((p) => p.state === 'killed').length,
      failed: postRows.filter((p) => p.state === 'failed').length,
      writesToday: writeRows.filter((r) => r.is_write).length,
      quotaRemaining: writeRows.flatMap((r) => typeof r.quota_remaining === 'number' ? [r.quota_remaining] : []).at(-1) ?? null,
    },
  };
}

const VoiceInput = z.object({ accountId: z.string().uuid().optional(), posts: z.array(z.string().min(40)).min(10).max(30) });
const PillarsInput = z.object({
  accountId: z.string().uuid().optional(),
  pillars: z.array(z.object({ name: z.string().min(1).max(80), description: z.string().min(1).max(500), targetShare: z.number().min(0).max(1) })).min(1).max(10),
});
const ConfigInput = z.object({
  accountId: z.string().uuid().optional(),
  timezone: z.string().min(1),
  windows: z.array(z.object({ day: z.number().int().min(1).max(7), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })).min(1),
  minGapMinutes: z.number().int().min(60), dailyCap: z.number().int().min(1).max(10), weeklyCap: z.number().int().min(1).max(30), jitterMinutes: z.number().int().min(0).max(60),
  ctaPolicy: z.record(z.unknown()).default({}), blockedTopics: z.array(z.string()).default([]), blockedClaims: z.array(z.string()).default([]),
  autonomyMode: z.enum(['autonomous', 'approval_queue']),
});
const KillSwitchInput = z.object({ accountId: z.string().uuid().optional(), engaged: z.boolean(), reason: z.string().max(500).optional() });
const PostInput = z.object({ accountId: z.string().uuid().optional(), pillarId: z.string().uuid().nullable().default(null), body: z.string().min(1).max(3000), scheduledAt: z.string().datetime().nullable().default(null) });
const PerformanceInput = z.object({ accountId: z.string().uuid().optional(), postId: z.string().uuid(), impressions: z.number().int().min(0), clicks: z.number().int().min(0).default(0), reactions: z.number().int().min(0).default(0), comments: z.number().int().min(0).default(0), shares: z.number().int().min(0).default(0), hoursSincePublish: z.number().int().min(0) });

function analyseVoice(posts: string[]): Record<string, unknown> {
  const sentences = posts.flatMap((post) => post.split(/(?<=[.!?])\s+/).filter(Boolean));
  const lengths = sentences.map((sentence) => sentence.trim().split(/\s+/).length);
  const mean = lengths.reduce((sum, length) => sum + length, 0) / Math.max(lengths.length, 1);
  const variance = lengths.reduce((sum, length) => sum + (length - mean) ** 2, 0) / Math.max(lengths.length, 1);
  const words = posts.join(' ').toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [];
  const common = [...words.reduce((map, word) => map.set(word, (map.get(word) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word]) => word);
  return {
    sentence_length: { mean: Number(mean.toFixed(1)), stddev: Number(Math.sqrt(variance).toFixed(1)), distribution: lengths },
    opener_patterns: posts.map((post) => post.split('\n')[0]?.slice(0, 120) ?? '').filter(Boolean).slice(0, 10),
    vocabulary: { favored: common, avoided: [] },
    structural_habits: ['Derived from founder-provided source posts'],
    line_break_style: { average_lines: Number((posts.reduce((sum, post) => sum + post.split('\n').length, 0) / posts.length).toFixed(1)) },
    paragraph_rhythm: { short_paragraph_bias: posts.filter((post) => post.includes('\n\n')).length / posts.length },
  };
}

async function authenticate(req: IncomingMessage): Promise<User> {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new ApiError(401, 'Missing bearer token');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, 'Invalid or expired session');
  return data.user;
}

async function requireOwnedAccount(ownerId: string, requested?: string): Promise<string> {
  let query = db.from('accounts').select('id').eq('owner_id', ownerId).eq('active', true);
  if (requested) query = query.eq('id', requested);
  const { data, error } = await query.limit(1).maybeSingle();
  throwDb(error);
  if (!data) throw new ApiError(404, 'No connected LinkedIn account');
  return data.id;
}

function signState(payload: { ownerId: string; nonce: string; exp: number }): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', env.OAUTH_STATE_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyState(value: string): { ownerId: string; nonce: string; exp: number } {
  const [encoded, supplied] = value.split('.');
  if (!encoded || !supplied) throw new ApiError(400, 'Invalid OAuth state');
  const expected = createHmac('sha256', env.OAUTH_STATE_SECRET).update(encoded).digest();
  const suppliedBuffer = Buffer.from(supplied, 'base64url');
  if (expected.length !== suppliedBuffer.length || !timingSafeEqual(expected, suppliedBuffer)) throw new ApiError(400, 'Invalid OAuth state');
  const payload = z.object({ ownerId: z.string().uuid(), nonce: z.string().min(16), exp: z.number() }).parse(JSON.parse(Buffer.from(encoded, 'base64url').toString()));
  if (payload.exp < Date.now()) throw new ApiError(400, 'OAuth state expired');
  return payload;
}

async function recordLedger(client: SupabaseClient, entry: LedgerEntry): Promise<void> {
  const { error } = await client.from('rate_ledger').insert({ account_id: entry.accountId, endpoint: entry.endpoint, method: entry.method, response_code: entry.responseCode, quota_remaining: entry.quota.remaining, quota_limit: entry.quota.limit, quota_reset_at: entry.quota.resetAt?.toISOString() ?? null, retry_after_s: entry.quota.retryAfterSeconds, is_write: entry.isWrite, duration_ms: entry.durationMs, error_body: entry.errorBody });
  throwDb(error);
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) throw new ApiError(413, 'Request body too large');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new ApiError(400, 'Invalid JSON'); }
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', env.DASHBOARD_URL);
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,OPTIONS');
  res.setHeader('Vary', 'Origin');
}
function send(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  if (value === null) { res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}
function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new ApiError(400, `Missing ${key}`);
  return value;
}
function throwDb(error: { message: string } | null): void { if (error) throw new Error(error.message); }
function startOfUtcDay(): string { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); }
function emptyStats(): Record<string, number | null> { return { published: 0, queued: 0, killed: 0, failed: 0, writesToday: 0, quotaRemaining: null }; }
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
