import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { Api, oneConfig, type Account, type CredentialStatus, type DashboardData } from './api.js';

type View = 'overview' | 'queue' | 'decisions' | 'setup' | 'settings';

export function App({ supabase, apiUrl }: { supabase: SupabaseClient; apiUrl: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoadingSession(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, [supabase]);
  if (loadingSession) return <Loading label="Opening the control room" />;
  if (!session) return <SignIn supabase={supabase} />;
  return <ControlRoom supabase={supabase} session={session} apiUrl={apiUrl} />;
}

function SignIn({ supabase }: { supabase: SupabaseClient }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    const { error: authError } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    if (authError) setError(authError.message); else setSent(true);
  }
  return <main className="auth-shell">
    <section className="auth-story">
      <div className="wordmark"><Mark /> CADENCE</div>
      <div><p className="eyebrow">AUTONOMOUS LINKEDIN OPERATIONS</p><h1>Your voice.<br /><em>On schedule.</em></h1><p className="lede">A quiet editorial system that drafts, challenges, and publishes—without turning your profile into a content machine.</p></div>
      <p className="footnote">Built for one careful operator, not a growth team.</p>
    </section>
    <section className="auth-panel">
      <form onSubmit={submit} className="auth-form">
        <span className="step-chip">PRIVATE CONTROL ROOM</span>
        <h2>{sent ? 'Check your inbox' : 'Sign in to Cadence'}</h2>
        <p>{sent ? `We sent a secure sign-in link to ${email}.` : 'Use the email attached to your Supabase account.'}</p>
        {!sent && <><label>Email address<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label><button className="button primary" type="submit">Send secure link <Arrow /></button></>}
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  </main>;
}

function ControlRoom({ supabase, session, apiUrl }: { supabase: SupabaseClient; session: Session; apiUrl: string }) {
  const api = useMemo(() => new Api(apiUrl, async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error('Session expired');
    return data.session.access_token;
  }), [apiUrl, supabase]);
  const [data, setData] = useState<DashboardData | null>(null);
  const [view, setView] = useState<View>('overview');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() { setRefreshing(true); setError(''); try { setData(await api.getDashboard()); } catch (e) { setError(message(e)); } finally { setRefreshing(false); } }
  useEffect(() => { void refresh(); }, []);
  if (!data && refreshing) return <Loading label="Reading the latest decisions" />;
  if (!data) return <ErrorState error={error} retry={() => void refresh()} />;
  const account = data.accounts[0] ?? null;
  const config = account ? oneConfig(account) : null;
  const halted = config?.kill_switch_engaged === true;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="wordmark"><Mark /> CADENCE</div>
      <nav>{(['overview', 'queue', 'decisions', 'setup', 'settings'] as View[]).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}><NavIcon name={item} />{item}</button>)}</nav>
      <div className="sidebar-bottom"><div className="operator"><span>{(session.user.email?.[0] ?? 'O').toUpperCase()}</span><div><strong>{session.user.email?.split('@')[0]}</strong><small>Operator</small></div></div><button className="signout" onClick={() => void supabase.auth.signOut()}>Sign out</button></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div><span className={`status-dot ${halted ? 'halted' : ''}`} />{halted ? 'Writes halted' : account ? 'System watching' : 'Setup required'}</div><button className={`kill ${halted ? 'resume' : ''}`} disabled={!account} onClick={async () => { if (!account) return; await api.killSwitch(account.id, !halted); await refresh(); }}>{halted ? 'Resume agent' : 'Stop all writes'}</button></header>
      {error && <div className="toast">{error}</div>}
      {view === 'overview' && <Overview data={data} account={account} onSetup={() => setView('setup')} onQueue={() => setView('queue')} />}
      {view === 'queue' && <Queue data={data} account={account} api={api} refresh={refresh} />}
      {view === 'decisions' && <Decisions data={data} />}
      {view === 'setup' && <Setup account={account} api={api} refresh={refresh} />}
      {view === 'settings' && <Settings api={api} />}
    </main>
  </div>;
}

function Overview({ data, account, onSetup, onQueue }: { data: DashboardData; account: Account | null; onSetup: () => void; onQueue: () => void }) {
  if (!account) return <EmptyConnect onSetup={onSetup} />;
  const config = oneConfig(account);
  const dryDays = config ? Math.max(0, Math.ceil((new Date(config.dry_run_until).getTime() - Date.now()) / 86_400_000)) : 0;
  const next = data.posts.find((post) => ['scheduled', 'approved'].includes(post.state));
  return <section className="page">
    <div className="page-heading"><div><p className="eyebrow">OPERATIONS OVERVIEW</p><h1>Good {greeting()}, <em>{account.display_name.split(' ')[0]}</em>.</h1><p>Here’s what your editorial system is doing while you work.</p></div><button className="button secondary" onClick={onQueue}>Open queue <Arrow /></button></div>
    {dryDays > 0 && <div className="notice"><strong>Observation period · {dryDays} day{dryDays === 1 ? '' : 's'} remaining</strong><span>The full pipeline is running, but database policy prevents live publishing.</span></div>}
    <div className="metric-grid">
      <Metric label="Published" value={data.stats.published} detail="last 100 posts" />
      <Metric label="Ready in queue" value={data.stats.queued} detail={next?.scheduled_at ? relative(next.scheduled_at) : 'nothing scheduled'} />
      <Metric label="Editorial kills" value={data.stats.killed} detail="quality held" />
      <Metric label="Writes today" value={data.stats.writesToday} detail={data.stats.quotaRemaining === null ? 'quota unreported' : `${data.stats.quotaRemaining} API calls remain`} />
    </div>
    <div className="overview-grid">
      <article className="card next-card"><div className="card-title"><span>NEXT IN CADENCE</span><small>{next?.scheduled_at ? formatDate(next.scheduled_at) : 'Awaiting a slot'}</small></div>{next ? <><p className="post-copy">{next.body}</p><div className="post-meta"><span>{next.content_pillars?.name ?? 'Unassigned pillar'}</span><span className={`state ${next.state}`}>{next.state}</span></div></> : <EmptyMini title="The queue is quiet" text="Add a reviewed post when you’re ready." />}</article>
      <article className="card"><div className="card-title"><span>RECENT DECISIONS</span><small>Traceable by design</small></div><div className="decision-list">{data.logs.slice(0, 5).map((log) => <div key={log.id}><span className={`log-mark ${log.level}`} /><div><strong>{log.decision}</strong><p>{log.rationale}</p></div><time>{relative(log.created_at)}</time></div>)}{data.logs.length === 0 && <EmptyMini title="No decisions yet" text="Worker activity will appear here." />}</div></article>
    </div>
  </section>;
}

function Queue({ data, account, api, refresh }: { data: DashboardData; account: Account | null; api: Api; refresh: () => Promise<void> }) {
  const [body, setBody] = useState(''); const [pillarId, setPillarId] = useState(''); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  if (!account) return <EmptyConnect onSetup={() => undefined} />;
  const pillars = account.content_pillars.filter((pillar) => pillar.active);
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); setError(''); try { await api.createPost({ accountId: account!.id, pillarId: pillarId || null, body, scheduledAt: null }); setBody(''); await refresh(); } catch (e) { setError(message(e)); } finally { setSaving(false); } }
  return <section className="page"><div className="page-heading"><div><p className="eyebrow">EDITORIAL QUEUE</p><h1>Posts with a <em>reason</em>.</h1><p>Every item is either ready, scheduled, held, or explicitly killed.</p></div></div>
    <div className="queue-layout"><form className="card composer" onSubmit={submit}><div className="card-title"><span>ADD A REVIEWED POST</span><small>{body.length}/3000</small></div><textarea required maxLength={3000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write in your real voice. The scheduler will find the right window." /><div className="composer-actions"><select value={pillarId} onChange={(e) => setPillarId(e.target.value)}><option value="">No pillar</option>{pillars.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select><button className="button primary" disabled={saving}>{saving ? 'Adding…' : 'Add to queue'}</button></div>{error && <p className="error">{error}</p>}</form>
      <div className="post-list">{data.posts.map((post) => <article className="card queue-item" key={post.id}><div className="post-meta"><span>{post.content_pillars?.name ?? 'Unassigned'}</span><span className={`state ${post.state}`}>{post.state}</span></div><p>{post.body}</p><footer><span>{post.scheduled_at ? `Scheduled ${formatDate(post.scheduled_at)}` : `Added ${post.state}`}</span>{(post.kill_reason || post.failure_reason) && <strong>{post.kill_reason ?? post.failure_reason}</strong>}</footer></article>)}{data.posts.length === 0 && <div className="card"><EmptyMini title="No posts yet" text="Your reviewed drafts will collect here." /></div>}</div></div>
  </section>;
}

function Decisions({ data }: { data: DashboardData }) {
  return <section className="page"><div className="page-heading"><div><p className="eyebrow">DECISION LEDGER</p><h1>The system shows its <em>work</em>.</h1><p>Every meaningful gate, deferral, publish, and halt carries a rationale.</p></div></div><div className="card ledger"><div className="ledger-head"><span>TIME</span><span>STAGE</span><span>DECISION</span><span>RATIONALE</span></div>{data.logs.map((log) => <div className="ledger-row" key={log.id}><time>{formatDate(log.created_at)}</time><span className={`stage-tag ${log.level}`}>{log.stage}</span><strong>{log.decision}</strong><p>{log.rationale}</p></div>)}{data.logs.length === 0 && <EmptyMini title="The ledger is empty" text="Start the worker to capture its first decision." />}</div></section>;
}

function Setup({ account, api, refresh }: { account: Account | null; api: Api; refresh: () => Promise<void> }) {
  const activeVoice = account?.voice_profiles.find((voice) => voice.active);
  const activePillars = account?.content_pillars.filter((pillar) => pillar.active) ?? [];
  const [posts, setPosts] = useState(''); const [pillars, setPillars] = useState(activePillars.length ? activePillars.map((p) => `${p.name} | ${p.description} | ${p.target_share}`).join('\n') : 'Operator lessons | Hard-won lessons from building and selling | 0.4\nSystems thinking | Frameworks that make complex work simpler | 0.35\nField notes | Specific observations from the week | 0.25');
  const [timezone, setTimezone] = useState(oneConfig(account)?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone); const [messageText, setMessageText] = useState('');
  async function connect() { try { const { url } = await api.startLinkedIn(); window.location.assign(url); } catch (e) { setMessageText(message(e)); } }
  async function saveVoice() { try { const values = posts.split(/\n\s*---+\s*\n/).map((p) => p.trim()).filter(Boolean); await api.saveVoice(values, account?.id); setMessageText('Voice profile saved.'); await refresh(); } catch (e) { setMessageText(message(e)); } }
  async function savePillars() { try { const values = pillars.split('\n').filter(Boolean).map((line) => { const [name, description, share] = line.split('|').map((v) => v.trim()); return { name: name ?? '', description: description ?? '', targetShare: Number(share) }; }); await api.savePillars(values, account?.id); setMessageText('Content pillars saved.'); await refresh(); } catch (e) { setMessageText(message(e)); } }
  async function saveStrategy() { try { await api.saveConfig({ accountId: account?.id, timezone, windows: [1,2,3,4,5].map((day) => ({ day, start: '08:30', end: '11:30' })), minGapMinutes: 240, dailyCap: 1, weeklyCap: 5, jitterMinutes: 12, ctaPolicy: { mechanic: 'comment_gate', product_name_in_body: false }, blockedTopics: [], blockedClaims: [], autonomyMode: 'approval_queue' }); setMessageText('Strategy saved.'); await refresh(); } catch (e) { setMessageText(message(e)); } }
  return <section className="page"><div className="page-heading"><div><p className="eyebrow">CALIBRATION</p><h1>Make it sound like <em>you</em>.</h1><p>Setup is deliberately short. The observation week does the cautious part.</p></div></div>{messageText && <div className="notice slim">{messageText}</div>}<div className="setup-stack">
    <SetupCard number="01" title="LinkedIn connection" done={!!account} detail={account ? `${account.display_name} · token valid until ${formatDate(account.token_expires_at)}` : 'Connect a personal profile with OpenID and w_member_social.'}><button className="button secondary" onClick={() => void connect()}>{account ? 'Reconnect account' : 'Connect LinkedIn'} <Arrow /></button></SetupCard>
    <SetupCard number="02" title="Voice calibration" done={!!activeVoice} detail={activeVoice ? `Voice profile v${activeVoice.version} is active.` : 'Paste 10–20 strong posts, separated by a line containing ---.'}><textarea className="setup-textarea" value={posts} onChange={(e) => setPosts(e.target.value)} placeholder={'First full post…\n\n---\n\nSecond full post…'} /><button className="button secondary" disabled={!account || posts.split(/\n\s*---+\s*\n/).filter((p) => p.trim().length >= 40).length < 10} onClick={() => void saveVoice()}>Extract voice profile</button></SetupCard>
    <SetupCard number="03" title="Content pillars" done={activePillars.length > 0} detail="One per line: name | description | target share. Shares must total 1.0."><textarea className="setup-textarea compact" value={pillars} onChange={(e) => setPillars(e.target.value)} /><button className="button secondary" disabled={!account} onClick={() => void savePillars()}>Save pillars</button></SetupCard>
    <SetupCard number="04" title="Publishing strategy" done={!!oneConfig(account)} detail="Conservative defaults: weekday mornings, one post daily, five weekly, four-hour minimum gap."><label className="inline-field">Timezone<input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label><button className="button primary" disabled={!account} onClick={() => void saveStrategy()}>Save safe defaults</button></SetupCard>
  </div></section>;
}

function SetupCard({ number, title, done, detail, children }: { number: string; title: string; done: boolean; detail: string; children: ReactNode }) { return <article className="card setup-card"><div className="setup-number">{done ? '✓' : number}</div><div className="setup-content"><div><h3>{title}</h3><p>{detail}</p></div><div className="setup-controls">{children}</div></div></article>; }
function Settings({ api }: { api: Api }) {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [linkedinClientId, setLinkedinClientId] = useState('');
  const [linkedinClientSecret, setLinkedinClientSecret] = useState('');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [messageText, setMessageText] = useState('');
  useEffect(() => { void api.getCredentialStatus().then(setStatus).catch((error) => setMessageText(message(error))); }, [api]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setMessageText('');
    try {
      const result = await api.saveCredentials({ linkedinClientId, linkedinClientSecret, anthropicApiKey });
      setLinkedinClientSecret(''); setAnthropicApiKey('');
      setStatus({ linkedinClientIdConfigured: true, linkedinClientSecretConfigured: true, anthropicApiKeyConfigured: true, tokenEncryptionConfigured: true });
      setMessageText(result.restartRequired ? 'Saved securely. Restart the API and worker to activate the new credentials.' : 'Saved securely.');
    } catch (error) { setMessageText(message(error)); }
    finally { setSaving(false); }
  }
  const complete = status && status.linkedinClientIdConfigured && status.linkedinClientSecretConfigured && status.anthropicApiKeyConfigured && status.tokenEncryptionConfigured;
  return <section className="page"><div className="page-heading"><div><p className="eyebrow">PRIVATE SETTINGS</p><h1>Connect the <em>engines</em>.</h1><p>Secrets are written to the server’s local environment file and are never returned to this browser.</p></div></div>
    {messageText && <div className="notice slim">{messageText}</div>}
    <div className="settings-grid">
      <form className="card settings-form" onSubmit={submit} autoComplete="off">
        <div className="card-title"><span>PROVIDER CREDENTIALS</span><small>{complete ? 'Configured' : 'Action required'}</small></div>
        <div className="settings-fields">
          <label>LinkedIn Client ID<input required minLength={3} value={linkedinClientId} onChange={(e) => setLinkedinClientId(e.target.value)} placeholder={status?.linkedinClientIdConfigured ? 'Configured — enter to replace' : 'From LinkedIn Developer Portal'} autoComplete="off" /></label>
          <label>LinkedIn Client Secret<input required minLength={8} type="password" value={linkedinClientSecret} onChange={(e) => setLinkedinClientSecret(e.target.value)} placeholder={status?.linkedinClientSecretConfigured ? 'Configured — enter to replace' : 'Client secret'} autoComplete="new-password" /></label>
          <label>Anthropic API Key<input required minLength={20} type="password" value={anthropicApiKey} onChange={(e) => setAnthropicApiKey(e.target.value)} placeholder={status?.anthropicApiKeyConfigured ? 'Configured — enter to replace' : 'sk-ant-…'} autoComplete="new-password" /></label>
          <button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Save credentials'}</button>
        </div>
      </form>
      <article className="card settings-status"><div className="card-title"><span>READINESS</span><small>Values stay hidden</small></div><div className="readiness-list">
        <Readiness label="LinkedIn application" ready={Boolean(status?.linkedinClientIdConfigured && status?.linkedinClientSecretConfigured)} />
        <Readiness label="Anthropic generation" ready={Boolean(status?.anthropicApiKeyConfigured)} />
        <Readiness label="Token encryption" ready={Boolean(status?.tokenEncryptionConfigured)} />
      </div><p className="settings-note">After saving, restart the local API and worker. Then use Setup to connect your LinkedIn profile through OAuth.</p></article>
    </div>
  </section>;
}
function Readiness({ label, ready }: { label: string; ready: boolean }) { return <div><span>{label}</span><strong className={ready ? 'ready' : ''}>{ready ? 'READY' : 'MISSING'}</strong></div>; }
function EmptyConnect({ onSetup }: { onSetup: () => void }) { return <section className="empty-connect"><div className="orbit"><Mark /></div><p className="eyebrow">ONE CONNECTION AWAY</p><h1>Give Cadence a profile<br />to <em>protect</em>.</h1><p>Connect LinkedIn, teach it your voice, and start a seven-day observation period.</p><button className="button primary" onClick={onSetup}>Begin setup <Arrow /></button></section>; }
function Metric({ label, value, detail }: { label: string; value: number; detail: string }) { return <article className="metric"><span>{label}</span><strong>{String(value).padStart(2, '0')}</strong><small>{detail}</small></article>; }
function EmptyMini({ title, text }: { title: string; text: string }) { return <div className="empty-mini"><strong>{title}</strong><p>{text}</p></div>; }
function Loading({ label }: { label: string }) { return <main className="loading"><Mark /><p>{label}</p></main>; }
function ErrorState({ error, retry }: { error: string; retry: () => void }) { return <main className="loading"><strong>Couldn’t open Cadence</strong><p>{error}</p><button className="button primary" onClick={retry}>Try again</button></main>; }
function Mark() { return <span className="mark" aria-hidden="true"><i /><i /><i /></span>; }
function Arrow() { return <span aria-hidden="true">↗</span>; }
function NavIcon({ name }: { name: View }) { return <span className="nav-icon" aria-hidden="true">{name === 'overview' ? '◫' : name === 'queue' ? '≡' : name === 'decisions' ? '⌁' : name === 'settings' ? '⚙' : '⌘'}</span>; }
function greeting() { const hour = new Date().getHours(); return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
function relative(value: string) { const diff = new Date(value).getTime() - Date.now(); const abs = Math.abs(diff); const unit = abs < 3_600_000 ? 'minute' : abs < 86_400_000 ? 'hour' : 'day'; const size = unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : 86_400_000; return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(diff / size), unit); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
