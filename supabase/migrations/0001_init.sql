-- 0001_init.sql — core schema for the autonomous LinkedIn agent (v1)
--
-- v1 scope is personal-profile-only (w_member_social). Tables for the deferred
-- Community Management surface (engagement_events, comment_replies) are NOT
-- created here; they land with the v2 migration when CMA approval does.
-- See LIMITS.md.
--
-- Every table has RLS enabled. The agent's worker connects with the service
-- role and bypasses RLS by design; the dashboard connects as the authenticated
-- owner and is constrained by owner_id. There is no anon access to anything.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

-- Token encryption at rest. The key lives in Postgres settings, injected from
-- the environment at deploy time — never stored in a table.
--   ALTER DATABASE postgres SET app.token_encryption_key = '<key>';
create or replace function app_encrypt(plaintext text)
returns bytea
language plpgsql
immutable
as $$
begin
  if plaintext is null then
    return null;
  end if;
  return pgp_sym_encrypt(plaintext, current_setting('app.token_encryption_key'));
end;
$$;

create or replace function app_decrypt(ciphertext bytea)
returns text
language plpgsql
immutable
as $$
begin
  if ciphertext is null then
    return null;
  end if;
  return pgp_sym_decrypt(ciphertext, current_setting('app.token_encryption_key'));
end;
$$;

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
-- v1 holds exactly one row: the founder's personal profile. account_type is
-- present so the v2 org migration is an insert, not an ALTER.

create type account_type as enum ('member', 'organization');

create table accounts (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) on delete cascade,
  account_type      account_type not null default 'member',

  -- urn:li:person:{id} for members, urn:li:organization:{id} for orgs.
  -- This is the author URN sent on every POST /rest/posts.
  urn               text not null,
  display_name      text not null,

  -- Role on the account. Always 'OWNER' for a member account; ADMINISTRATOR /
  -- DIRECT_SPONSORED_CONTENT_POSTER etc. once org discovery exists in v2.
  role              text not null default 'OWNER',

  access_token_enc  bytea not null,
  refresh_token_enc bytea,
  -- 60-day access token, 365-day refresh token. The refresh job renews at
  -- T-7d. When refresh_expires_at passes, re-auth is MANUAL — there is no
  -- programmatic escape. Calendar reminder at day 350.
  token_expires_at        timestamptz not null,
  refresh_expires_at      timestamptz,
  scopes            text[] not null default '{}',

  active            boolean not null default true,
  -- Set by the scheduler when an account trips rate limits twice in an hour.
  -- Cleared at the start of the next UTC-offset local day.
  paused_until      timestamptz,
  pause_reason      text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (owner_id, urn)
);

create index accounts_owner_active_idx on accounts (owner_id) where active;
create trigger accounts_updated_at before update on accounts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- voice_profiles
-- ---------------------------------------------------------------------------
-- Extracted from 10-20 pasted high-performing posts during setup. Versioned so
-- a regression in output can be traced to a profile change. Exactly one row per
-- account has active = true.

create table voice_profiles (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  version       integer not null,

  -- Structured style JSON. Loaded into every generation call.
  -- Shape: { sentence_length: {mean, stddev, distribution},
  --          opener_patterns: [...], vocabulary: {favored, avoided},
  --          structural_habits: [...], line_break_style: {...},
  --          paragraph_rhythm: {...} }
  profile       jsonb not null,

  -- The posts it was derived from, for re-derivation and audit.
  source_posts  text[] not null default '{}',
  active        boolean not null default false,
  created_at    timestamptz not null default now(),

  unique (account_id, version)
);

create unique index voice_profiles_one_active_idx
  on voice_profiles (account_id) where active;

-- ---------------------------------------------------------------------------
-- content_pillars
-- ---------------------------------------------------------------------------

create table content_pillars (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  name          text not null,
  description   text not null,

  -- Target share of output, 0..1. Adjusted by the weekly learning loop, capped
  -- at +/- 0.15 absolute change per week so one viral outlier can't reshape
  -- the whole strategy.
  target_share  numeric(4,3) not null check (target_share >= 0 and target_share <= 1),
  example_posts text[] not null default '{}',

  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (account_id, name)
);

create trigger content_pillars_updated_at before update on content_pillars
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- post_queue
-- ---------------------------------------------------------------------------

create type post_state as enum (
  'draft', 'approved', 'scheduled', 'published', 'failed', 'killed'
);

create table post_queue (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts(id) on delete cascade,
  pillar_id       uuid references content_pillars(id) on delete set null,

  body            text not null,
  state           post_state not null default 'draft',

  scheduled_at    timestamptz,
  published_at    timestamptz,
  -- urn:li:share:{id} returned by POST /rest/posts
  published_urn   text,

  failure_reason  text,
  -- Populated when state = 'killed'. The slop/fact gate violations that killed
  -- it, so the dashboard can show *why* rather than just that it happened.
  kill_reason     text,
  gate_violations jsonb,

  -- Which prompt + voice profile produced this, for regression tracing.
  prompt_version    text not null,
  voice_profile_id  uuid references voice_profiles(id) on delete set null,
  -- Structural fingerprint used to block two similar posts within 10 days.
  structure_hash    text,
  generation_params jsonb not null default '{}',

  -- Media uploaded via /rest/images or /rest/videos, referenced by URN.
  media_urns      text[] not null default '{}',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The scheduler's hot path: due posts for active accounts.
create index post_queue_due_idx on post_queue (scheduled_at)
  where state in ('approved', 'scheduled');
create index post_queue_account_state_idx on post_queue (account_id, state);
create index post_queue_structure_idx on post_queue (account_id, structure_hash, published_at)
  where published_urn is not null;

create trigger post_queue_updated_at before update on post_queue
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- rate_ledger
-- ---------------------------------------------------------------------------
-- Every outbound LinkedIn API call, with the quota headers it came back with.
-- Written on success AND failure. This is what the pre-flight check reads to
-- stay under the ~100/day/member ceiling with headroom, rather than
-- discovering the limit by hitting it.

create table rate_ledger (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid references accounts(id) on delete cascade,

  endpoint          text not null,
  method            text not null,
  response_code     integer,

  -- Parsed from response headers; null when LinkedIn doesn't send them.
  quota_remaining   integer,
  quota_limit       integer,
  quota_reset_at    timestamptz,
  retry_after_s     integer,

  -- true for writes that count against the daily ceiling.
  is_write          boolean not null default false,
  duration_ms       integer,
  error_body        text,

  created_at        timestamptz not null default now()
);

-- Pre-flight daily-budget query.
create index rate_ledger_budget_idx on rate_ledger (account_id, created_at)
  where is_write;
-- Anomaly-halt query: failure rate in a rolling hour.
create index rate_ledger_recent_idx on rate_ledger (created_at, response_code);

-- ---------------------------------------------------------------------------
-- agent_log
-- ---------------------------------------------------------------------------
-- Structured decision log. Every meaningful decision the agent makes lands here
-- with the prompt version that produced it, so a regression is traceable to a
-- specific change.

create table agent_log (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid references accounts(id) on delete cascade,

  -- 'ideation' | 'selection' | 'drafting' | 'slop_gate' | 'fact_gate'
  -- | 'cta_policy' | 'schedule' | 'publish' | 'refresh' | 'halt' | ...
  stage         text not null,
  -- 'info' | 'warn' | 'error'
  level         text not null default 'info',
  decision      text not null,
  -- Why. Free-form but always populated — a log line without a reason is noise.
  rationale     text,

  post_id       uuid references post_queue(id) on delete set null,
  prompt_version text,
  model         text,

  input_tokens  integer,
  output_tokens integer,
  cost_usd      numeric(10,6),

  detail        jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create index agent_log_account_time_idx on agent_log (account_id, created_at desc);
create index agent_log_stage_idx on agent_log (stage, created_at desc);
create index agent_log_post_idx on agent_log (post_id) where post_id is not null;

-- ---------------------------------------------------------------------------
-- performance
-- ---------------------------------------------------------------------------
-- Per-post metrics, joined back to pillar and generation params by the weekly
-- learning loop.
--
-- v1 NOTE: post analytics are Community Management-gated, so there is no API
-- feed for this table. Rows are entered manually via the dashboard from
-- LinkedIn's own analytics UI. `source` records which, so that when CMA
-- approval lands the two can be told apart and manual rows retired.

create type performance_source as enum ('manual', 'api');

create table performance (
  id                  uuid primary key default gen_random_uuid(),
  post_id             uuid not null references post_queue(id) on delete cascade,
  account_id          uuid not null references accounts(id) on delete cascade,

  source              performance_source not null default 'manual',

  impressions         integer,
  unique_impressions  integer,
  clicks              integer,
  reactions           integer,
  comments            integer,
  shares              integer,
  -- Stored rather than computed so a changed formula doesn't silently rewrite
  -- history.
  engagement_rate     numeric(6,5),

  -- Rolling pulls: same post measured at 24h, 7d, 30d.
  measured_at         timestamptz not null default now(),
  hours_since_publish integer,

  created_at          timestamptz not null default now(),

  unique (post_id, hours_since_publish)
);

create index performance_account_time_idx on performance (account_id, measured_at desc);

-- ---------------------------------------------------------------------------
-- agent_config
-- ---------------------------------------------------------------------------
-- Strategy config from the setup wizard: posting windows, caps, CTA policy,
-- blocklist. One row per account, JSON so the wizard can evolve the shape
-- without a migration.

create table agent_config (
  account_id      uuid primary key references accounts(id) on delete cascade,

  timezone        text not null default 'America/New_York',

  -- { windows: [{day: 1..7, start: "08:30", end: "11:00"}],
  --   min_gap_minutes: 240, daily_cap: 2, weekly_cap: 7,
  --   jitter_minutes: 12,
  --   underperform_cooldown: {threshold_percentile: 15, hours: 48} }
  schedule        jsonb not null default '{}',

  -- { mechanic: "comment_gate", product_name_in_body: false,
  --   destination: "signup" }
  cta_policy      jsonb not null default '{}',

  -- Hard blocklist of topics and claims. Checked at the fact gate.
  blocked_topics  text[] not null default '{}',
  blocked_claims  text[] not null default '{}',

  -- 'autonomous' | 'approval_queue'. Defaults to approval_queue; the 7-day
  -- dry-run window is enforced by dry_run_until.
  autonomy_mode   text not null default 'approval_queue',
  dry_run_until   timestamptz not null default (now() + interval '7 days'),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger agent_config_updated_at before update on agent_config
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Owner-scoped on every table. The worker uses the service role key and
-- bypasses these; the dashboard does not.

alter table accounts        enable row level security;
alter table voice_profiles  enable row level security;
alter table content_pillars enable row level security;
alter table post_queue      enable row level security;
alter table rate_ledger     enable row level security;
alter table agent_log       enable row level security;
alter table performance     enable row level security;
alter table agent_config    enable row level security;

create policy accounts_owner on accounts
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Child tables inherit ownership through accounts.
create policy voice_profiles_owner on voice_profiles
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));

create policy content_pillars_owner on content_pillars
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));

create policy post_queue_owner on post_queue
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));

create policy rate_ledger_owner on rate_ledger
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));

create policy agent_log_owner on agent_log
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));

create policy performance_owner on performance
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));

create policy agent_config_owner on agent_config
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));
