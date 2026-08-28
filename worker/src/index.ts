import { createClient } from '@supabase/supabase-js';
import { LinkedInClient } from '@agent/linkedin-client';
import { ModelClient } from '@agent/content-engine';
import { z } from 'zod';
import WebSocket from 'ws';
import { SupabaseWriteGuard } from './lib/guard.js';
import { runSchedulerTick } from './jobs/scheduler.js';
import { runTokenRefresh } from './jobs/refresh-tokens.js';
import { sendDailyDigest } from './jobs/digest.js';
import { createMailer } from './email.js';
import { SupabaseRuntimeStore } from './store.js';
import { MissingCredentialsError, resolveCredentials } from './lib/credentials.js';
import { runIdeation } from './jobs/ideation.js';

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_REDIRECT_URI: z.string().url(),
  LINKEDIN_API_VERSION: z.string().regex(/^\d{6}$/),
  LINKEDIN_SCOPES: z.string().default('openid profile email w_member_social'),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  ANTHROPIC_API_KEY: z.string().min(20).optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  AGENT_KILL_SWITCH: z.string().default('false'),
  AGENT_DRY_RUN: z.string().default('true'),
  DAILY_WRITE_BUDGET: z.coerce.number().int().positive().default(80),
  SCHEDULER_INTERVAL_MINUTES: z.coerce.number().positive().default(15),
  ANOMALY_FAILURE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.2),
  IDEATION_INTERVAL_HOURS: z.coerce.number().positive().default(6),
  IDEATION_QUEUE_TARGET: z.coerce.number().int().min(1).max(10).default(3),
  IDEATION_ENABLED: z.string().default('false'),
  // When true, env credentials are never used as a fallback. Set this on any
  // deployment more than one person can sign into.
  MULTI_TENANT: z.string().default('false'),
  RESEND_API_KEY: z.string().optional(),
  ALERT_EMAIL_TO: z.string().email().optional(),
  ALERT_EMAIL_FROM: z.string().optional(),
});

const env = Env.parse(process.env);
const webSocketTransport = WebSocket as unknown as new (address: string | URL, protocols?: string | string[]) => any;
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: webSocketTransport },
});
const store = new SupabaseRuntimeStore(db, env.TOKEN_ENCRYPTION_KEY);
const guard = new SupabaseWriteGuard(store, {
  envKillSwitch: truthy(env.AGENT_KILL_SWITCH),
  envDryRun: truthy(env.AGENT_DRY_RUN),
  dailyWriteBudget: env.DAILY_WRITE_BUDGET,
  rateLimitTripsBeforePause: 2,
});
/**
 * Per-owner clients, built on demand and cached for the life of the process.
 *
 * Previously one LinkedInClient and one ModelClient were built at boot from
 * process env, so every account published through the same LinkedIn app and
 * billed the same Anthropic key regardless of who owned it.
 */
const envFallback = {
  ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
  anthropicModel: env.ANTHROPIC_MODEL,
  anthropicEffort: env.ANTHROPIC_EFFORT,
  ...(env.LINKEDIN_CLIENT_ID ? { linkedinClientId: env.LINKEDIN_CLIENT_ID } : {}),
  ...(env.LINKEDIN_CLIENT_SECRET ? { linkedinClientSecret: env.LINKEDIN_CLIENT_SECRET } : {}),
  multiTenant: truthy(env.MULTI_TENANT),
};

const clientCache = new Map<string, { linkedin: LinkedInClient; model: ModelClient }>();

async function clientsForOwner(ownerId: string) {
  const cached = clientCache.get(ownerId);
  if (cached) return cached;

  const stored = await store.credentialsForOwner(ownerId);
  // Throws MissingCredentialsError, which callers turn into a skip.
  const creds = resolveCredentials({ ownerId, stored, env: envFallback });

  const built = {
    linkedin: new LinkedInClient({
      apiVersion: env.LINKEDIN_API_VERSION,
      ledger: guard,
      guard,
      oauth: {
        clientId: creds.linkedinClientId,
        clientSecret: creds.linkedinClientSecret,
        redirectUri: env.LINKEDIN_REDIRECT_URI,
        scopes: env.LINKEDIN_SCOPES.split(/\s+/).filter(Boolean),
      },
    }),
    model: new ModelClient({
      apiKey: creds.anthropicApiKey,
      model: creds.anthropicModel,
      effort: creds.anthropicEffort,
    }),
  };
  clientCache.set(ownerId, built);
  return built;
}

/** Null rather than throw, so one unconfigured owner cannot stop the tick. */
async function postsForAccount(account: { id: string; ownerId?: string | null }) {
  const ownerId = account.ownerId;
  if (!ownerId) return null;
  try {
    return (await clientsForOwner(ownerId)).linkedin.posts;
  } catch (error) {
    if (error instanceof MissingCredentialsError) return null;
    throw error;
  }
}

const mailer = createMailer({
  ...(env.RESEND_API_KEY ? { apiKey: env.RESEND_API_KEY } : {}),
  ...(env.ALERT_EMAIL_TO ? { to: env.ALERT_EMAIL_TO } : {}),
  ...(env.ALERT_EMAIL_FROM ? { from: env.ALERT_EMAIL_FROM } : {}),
});

let schedulerBusy = false;
async function scheduler(): Promise<void> {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const result = await runSchedulerTick({
      now: new Date(),
      deps: store.schedulerDeps(postsForAccount, {
        envKillSwitch: truthy(env.AGENT_KILL_SWITCH),
        failureThreshold: env.ANOMALY_FAILURE_THRESHOLD,
      }),
    });
    console.info(JSON.stringify({ job: 'scheduler', ...result, at: new Date().toISOString() }));
    if (result.halted && result.haltReason) {
      await mailer.send('Cadence halted outbound writes', result.haltReason);
    }
  } catch (error) {
    console.error('scheduler tick failed', error);
  } finally {
    schedulerBusy = false;
  }
}

async function refresh(): Promise<void> {
  try {
    const result = await runTokenRefresh({
      now: new Date(),
      // Refresh must use the app that ISSUED the token. Using another owner's
      // client_id returns invalid_grant, which reads like an expired token.
      deps: store.refreshDeps(
        {
          refresh: async (refreshToken: string) => {
            const ownerId = await store.ownerForRefreshToken(refreshToken);
            if (!ownerId) throw new Error('No owner for this refresh token; cannot pick an app.');
            return (await clientsForOwner(ownerId)).linkedin.oauth.refresh(refreshToken);
          },
        },
        (subject, body) => mailer.send(subject, body),
      ),
    });
    console.info(JSON.stringify({ job: 'token-refresh', result, at: new Date().toISOString() }));
  } catch (error) {
    console.error('token refresh failed', error);
  }
}

async function digest(): Promise<void> {
  try {
    await sendDailyDigest(db, mailer);
  } catch (error) {
    console.error('daily digest failed', error);
  }
}

let ideationBusy = false;
async function ideate(): Promise<void> {
  if (ideationBusy) return;
  ideationBusy = true;
  try {
    // Ideation bills the owner's own Anthropic key. Null means unconfigured,
    // and that account is skipped rather than charged to someone else.
    const result = await runIdeation({
      db,
      modelFor: async (ownerId: string) => {
        try { return (await clientsForOwner(ownerId)).model; }
        catch (error) {
          if (error instanceof MissingCredentialsError) return null;
          throw error;
        }
      },
      now: new Date(),
      queueTarget: env.IDEATION_QUEUE_TARGET,
    });
    console.info(JSON.stringify({ job: 'ideation', ...result, at: new Date().toISOString() }));
  } catch (error) {
    console.error('ideation failed', error);
  } finally { ideationBusy = false; }
}

console.info(`Cadence worker started; scheduler every ${env.SCHEDULER_INTERVAL_MINUTES} minutes.`);
void scheduler();
void refresh();
if (truthy(env.IDEATION_ENABLED)) void ideate();
const schedulerTimer = setInterval(() => void scheduler(), env.SCHEDULER_INTERVAL_MINUTES * 60_000);
const refreshTimer = setInterval(() => void refresh(), 24 * 60 * 60_000);
const digestTimer = setInterval(() => void digest(), 24 * 60 * 60_000);
const ideationTimer = truthy(env.IDEATION_ENABLED)
  ? setInterval(() => void ideate(), env.IDEATION_INTERVAL_HOURS * 60 * 60_000)
  : null;

function shutdown(signal: string): void {
  console.info(`${signal}: stopping Cadence worker`);
  clearInterval(schedulerTimer);
  clearInterval(refreshTimer);
  clearInterval(digestTimer);
  if (ideationTimer) clearInterval(ideationTimer);
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

function truthy(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
