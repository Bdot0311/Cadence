import type { SupabaseClient } from '@supabase/supabase-js';
import type { Mailer } from '../email.js';

export async function sendDailyDigest(db: SupabaseClient, mailer: Mailer, now = new Date()): Promise<void> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const [posts, logs, ledger] = await Promise.all([
    db.from('post_queue').select('state,body,published_at,kill_reason,failure_reason').gte('updated_at', since),
    db.from('agent_log').select('level,stage,decision,rationale').gte('created_at', since).order('created_at', { ascending: false }).limit(20),
    db.from('rate_ledger').select('is_write,response_code,quota_remaining').gte('created_at', since),
  ]);
  for (const result of [posts, logs, ledger]) if (result.error) throw new Error(result.error.message);
  const rows = posts.data ?? [];
  const published = rows.filter((p) => p.state === 'published');
  const killed = rows.filter((p) => p.state === 'killed');
  const failed = rows.filter((p) => p.state === 'failed');
  const writes = (ledger.data ?? []).filter((r) => r.is_write).length;
  const remaining = (ledger.data ?? []).flatMap((r) => typeof r.quota_remaining === 'number' ? [r.quota_remaining] : []);
  const text = [
    `Cadence daily digest — ${now.toISOString().slice(0, 10)}`,
    '',
    `Published: ${published.length}`,
    `Killed by editorial gates: ${killed.length}`,
    `Failed: ${failed.length}`,
    `LinkedIn writes consumed: ${writes}`,
    `Last reported quota remaining: ${remaining.at(-1) ?? 'not reported'}`,
    '',
    ...published.map((p) => `PUBLISHED — ${String(p.body).slice(0, 180)}`),
    ...killed.map((p) => `KILLED — ${p.kill_reason ?? 'No reason recorded'}`),
    ...failed.map((p) => `FAILED — ${p.failure_reason ?? 'No reason recorded'}`),
    '',
    'Recent decisions:',
    ...(logs.data ?? []).map((l) => `[${l.level}] ${l.stage}/${l.decision}: ${l.rationale ?? ''}`),
  ].join('\n');
  await mailer.send(`Cadence: ${published.length} published, ${killed.length} killed, ${failed.length} failed`, text);
}
