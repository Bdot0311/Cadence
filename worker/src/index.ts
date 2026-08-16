import { createClient } from '@supabase/supabase-js';
import { LinkedInClient } from '@agent/linkedin-client';
import { z } from 'zod';
import { SupabaseWriteGuard } from './lib/guard.js';
import { runSchedulerTick } from './jobs/scheduler.js';
import { runTokenRefresh } from './jobs/refresh-tokens.js';
import { sendDailyDigest } from './jobs/digest.js';
import { createMailer } from './email.js';
import { SupabaseRuntimeStore } from './store.js';

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  LINKEDIN_CLIENT_ID: z.string().min(1),
  LINKEDIN_CLIENT_SECRET: z.string().min(1),
  LINKEDIN_REDIRECT_URI: z.string().url(),
  LINKEDIN_API_VERSION: z.string().regex(/^\d{6}$/),
  LINKEDIN_SCOPES: z.string().default('openid profile email w_member_social'),
  AGENT_KILL_SWITCH: z.string().default('false'),
  AGENT_DRY_RUN: z.string().default('true'),
  DAILY_WRITE_BUDGET: z.coerce.number().int().positive().default(80),
  SCHEDULER_INTERVAL_MINUTES: z.coerce.number().positive().default(15),
  ANOMALY_FAILURE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.2),
  RESEND_API_KEY: z.string().optional(),
  ALERT_EMAIL_TO: z.string().email().optional(),
  ALERT_EMAIL_FROM: z.string().optional(),
});

const env = Env.parse(process.env);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const store = new SupabaseRuntimeStore(db);
const guard = new SupabaseWriteGuard(store, {
  envKillSwitch: truthy(env.AGENT_KILL_SWITCH),
  envDryRun: truthy(env.AGENT_DRY_RUN),
  dailyWriteBudget: env.DAILY_WRITE_BUDGET,
  rateLimitTripsBeforePause: 2,
});
const linkedin = new LinkedInClient({
  apiVersion: env.LINKEDIN_API_VERSION,
  ledger: guard,
  guard,
  oauth: {
    clientId: env.LINKEDIN_CLIENT_ID,
    clientSecret: env.LINKEDIN_CLIENT_SECRET,
    redirectUri: env.LINKEDIN_REDIRECT_URI,
    scopes: env.LINKEDIN_SCOPES.split(/\s+/).filter(Boolean),
  },
});
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
      deps: store.schedulerDeps(linkedin.posts, {
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
      deps: store.refreshDeps(linkedin.oauth, (subject, body) => mailer.send(subject, body)),
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

console.info(`Cadence worker started; scheduler every ${env.SCHEDULER_INTERVAL_MINUTES} minutes.`);
void scheduler();
void refresh();
const schedulerTimer = setInterval(() => void scheduler(), env.SCHEDULER_INTERVAL_MINUTES * 60_000);
const refreshTimer = setInterval(() => void refresh(), 24 * 60 * 60_000);
const digestTimer = setInterval(() => void digest(), 24 * 60 * 60_000);

function shutdown(signal: string): void {
  console.info(`${signal}: stopping Cadence worker`);
  clearInterval(schedulerTimer);
  clearInterval(refreshTimer);
  clearInterval(digestTimer);
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

function truthy(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
