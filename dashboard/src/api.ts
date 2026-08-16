export interface DashboardData {
  accounts: Account[];
  posts: Post[];
  logs: LogEntry[];
  performance: unknown[];
  stats: { published: number; queued: number; killed: number; failed: number; writesToday: number; quotaRemaining: number | null };
}
export interface Account {
  id: string; urn: string; display_name: string; active: boolean;
  paused_until: string | null; pause_reason: string | null; token_expires_at: string;
  refresh_expires_at: string | null; created_at: string;
  agent_config: Config | Config[] | null;
  content_pillars: Pillar[];
  voice_profiles: Array<{ id: string; version: number; active: boolean; profile: Record<string, unknown> }>;
}
export interface Config {
  timezone: string; schedule: Record<string, unknown>; autonomy_mode: string;
  dry_run_until: string; kill_switch_engaged: boolean; halt_reason: string | null;
  blocked_topics: string[]; blocked_claims: string[]; cta_policy: Record<string, unknown>;
}
export interface Pillar { id: string; name: string; description: string; target_share: number; active: boolean }
export interface Post {
  id: string; account_id: string; body: string; state: string; scheduled_at: string | null;
  published_at: string | null; kill_reason: string | null; failure_reason: string | null;
  content_pillars: { name: string } | null;
}
export interface LogEntry { id: string; level: string; stage: string; decision: string; rationale: string; created_at: string }
export interface CredentialStatus {
  linkedinClientIdConfigured: boolean;
  linkedinClientSecretConfigured: boolean;
  anthropicApiKeyConfigured: boolean;
  tokenEncryptionConfigured: boolean;
}

export class Api {
  constructor(private readonly base: string, private readonly token: () => Promise<string>) {}
  getDashboard(): Promise<DashboardData> { return this.request('/api/dashboard'); }
  getCredentialStatus(): Promise<CredentialStatus> { return this.request('/api/settings/status'); }
  saveCredentials(input: { linkedinClientId: string; linkedinClientSecret: string; anthropicApiKey: string }): Promise<{ saved: boolean; restartRequired: boolean }> {
    return this.request('/api/settings/credentials', { method: 'PUT', body: JSON.stringify(input) });
  }
  startLinkedIn(): Promise<{ url: string }> { return this.request('/auth/linkedin/start', { method: 'POST' }); }
  saveVoice(posts: string[], accountId?: string): Promise<unknown> { return this.request('/api/voice-profile', { method: 'POST', body: JSON.stringify({ posts, accountId }) }); }
  savePillars(pillars: Array<{ name: string; description: string; targetShare: number }>, accountId?: string): Promise<unknown> { return this.request('/api/pillars', { method: 'PUT', body: JSON.stringify({ pillars, accountId }) }); }
  saveConfig(config: Record<string, unknown>): Promise<unknown> { return this.request('/api/config', { method: 'PUT', body: JSON.stringify(config) }); }
  killSwitch(accountId: string, engaged: boolean): Promise<unknown> { return this.request('/api/kill-switch', { method: 'POST', body: JSON.stringify({ accountId, engaged }) }); }
  createPost(input: { accountId: string; pillarId: string | null; body: string; scheduledAt: string | null }): Promise<unknown> { return this.request('/api/posts', { method: 'POST', body: JSON.stringify(input) }); }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', ...init.headers },
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
    return data as T;
  }
}

export function oneConfig(account: Account | null | undefined): Config | null {
  if (!account) return null;
  return Array.isArray(account.agent_config) ? account.agent_config[0] ?? null : account.agent_config;
}
