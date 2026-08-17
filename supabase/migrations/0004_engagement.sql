-- 0004_engagement.sql — the v2 engagement loop.
--
-- Everything here supports capabilities gated behind Community Management API
-- approval. The tables are created now so the code paths are testable and the
-- migration is not on the critical path the day approval lands, but nothing
-- writes to them until ORG_FEATURES_ENABLED is on AND the token carries
-- r_organization_social / w_organization_social. See LIMITS.md.
--
-- Safe to apply before approval: creating empty tables changes no behaviour.

-- ---------------------------------------------------------------------------
-- engagement_events — raw inbound from Organization Social Action Notifications
-- ---------------------------------------------------------------------------
-- Written by the webhook receiver. Deliberately dumb: store the payload as it
-- arrived, mark it unprocessed, and let the worker interpret it. A webhook
-- handler that classifies inline loses the event when classification throws,
-- and LinkedIn does not redeliver on demand.

create type engagement_event_type as enum ('comment', 'reaction', 'unknown');

create table engagement_events (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts(id) on delete cascade,

  event_type      engagement_event_type not null default 'unknown',

  -- urn:li:comment:(urn:li:share:123,456) for comments.
  event_urn       text,
  -- The post the event happened on.
  parent_post_urn text not null,
  -- Person or organization that acted. Stored as the URN LinkedIn sent; we
  -- cannot resolve it to a profile, since member lookup is not available.
  actor_urn       text,
  comment_text    text,
  -- Present when the comment is itself a reply. Used to avoid treating our own
  -- reply as a new inbound comment.
  parent_comment_urn text,

  -- Verbatim webhook body, for replaying a misclassification without needing
  -- LinkedIn to resend.
  raw_payload     jsonb not null default '{}',

  processed       boolean not null default false,
  processed_at    timestamptz,
  -- Set when processing failed, so a poison event does not spin forever.
  process_error   text,
  process_attempts integer not null default 0,

  occurred_at     timestamptz,
  created_at      timestamptz not null default now(),

  -- LinkedIn can deliver the same notification more than once. The unique index
  -- is the dedupe, rather than a check-then-insert that races with itself.
  unique (account_id, event_urn)
);

create index engagement_events_unprocessed_idx
  on engagement_events (account_id, created_at)
  where not processed;
create index engagement_events_post_idx on engagement_events (parent_post_urn);

-- ---------------------------------------------------------------------------
-- comment_replies — what we decided to do, and what we sent
-- ---------------------------------------------------------------------------
-- One row per inbound comment we considered, INCLUDING the ones we chose not to
-- answer. Recording the silences matters as much as recording the replies: a
-- hostile comment that got no reply should be visible in the digest as a
-- deliberate decision, not absent because nothing happened.

create type comment_class as enum (
  'question', 'objection', 'praise', 'spam', 'lead-signal', 'hostile'
);

create type reply_state as enum (
  'pending',    -- classified, reply generated, waiting out the delay
  'scheduled',  -- has a send time inside active hours
  'sent',
  'skipped',    -- deliberately not replying; see skip_reason
  'failed',
  'killed'      -- generated reply failed the slop gate
);

create table comment_replies (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references accounts(id) on delete cascade,
  engagement_event_id uuid not null references engagement_events(id) on delete cascade,

  -- Inbound
  comment_urn         text not null,
  comment_text        text not null,
  actor_urn           text,
  parent_post_urn     text not null,

  classification      comment_class,
  -- Model's own confidence, for tuning the classifier later.
  classification_confidence numeric(4,3),

  -- Outbound
  reply_text          text,
  -- 'generated' | 'objection-library'
  reply_source        text,
  state               reply_state not null default 'pending',
  -- Populated for state = 'skipped'. Always human-readable: this is what the
  -- digest shows when explaining why the agent stayed quiet.
  skip_reason         text,

  -- Randomized 20-90 minute hold, pushed to the next active-hours opening.
  send_after          timestamptz,
  sent_at             timestamptz,
  published_urn       text,
  failure_reason      text,

  -- Same gate machinery as posts. A reply that fails the slop gate is killed
  -- rather than sent, and the violations are kept for the dashboard.
  gate_violations     jsonb,
  prompt_version      text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- One decision per inbound comment. Re-processing updates rather than
  -- inserting, which is what stops a redelivered webhook becoming a second
  -- reply in the same thread.
  unique (account_id, comment_urn)
);

create index comment_replies_due_idx on comment_replies (send_after)
  where state in ('pending', 'scheduled');
create index comment_replies_thread_idx on comment_replies (account_id, parent_post_urn);

create trigger comment_replies_updated_at before update on comment_replies
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- leads — buying signals worth acting on personally
-- ---------------------------------------------------------------------------
-- The agent flags; the founder acts. There is no outbound action attached to a
-- lead row, because contacting someone would require DMs or connection
-- requests, neither of which is available. See LIMITS.md.

create table leads (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts(id) on delete cascade,

  actor_urn       text,
  -- Whatever LinkedIn gave us. We cannot look up a profile to enrich this.
  actor_name      text,
  source_comment_urn text,
  parent_post_urn text,
  signal_text     text not null,
  rationale       text,

  -- 'new' | 'contacted' | 'dismissed'. Moved by the founder in the dashboard.
  state           text not null default 'new',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (account_id, source_comment_urn)
);

create index leads_state_idx on leads (account_id, state, created_at desc);

create trigger leads_updated_at before update on leads
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- objection library
-- ---------------------------------------------------------------------------
-- Pre-approved responses to known objections. When an objection arrives and no
-- entry matches, the agent stays SILENT rather than improvising a rebuttal —
-- see routeComment in packages/content-engine/src/comment-policy.ts.

create table objection_library (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,

  label         text not null,
  -- Trigger phrases, matched case-insensitively against the comment.
  match_phrases text[] not null default '{}',
  response      text not null,
  active        boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (account_id, label)
);

create trigger objection_library_updated_at before update on objection_library
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- accounts: track which org scopes a token actually carries
-- ---------------------------------------------------------------------------
-- `scopes` already exists on accounts. This view is a convenience for the
-- dashboard deciding whether to render the org UI at all, so the check lives in
-- one place rather than being re-derived in the client.

create or replace view account_capabilities as
select
  a.id as account_id,
  a.account_type,
  a.urn,
  'w_member_social' = any(a.scopes)        as can_publish_member,
  'w_organization_social' = any(a.scopes)  as can_publish_org,
  'r_organization_social' = any(a.scopes)  as can_read_engagement
from accounts a;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table engagement_events   enable row level security;
alter table comment_replies     enable row level security;
alter table leads               enable row level security;
alter table objection_library   enable row level security;

create policy engagement_events_owner on engagement_events
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));

create policy comment_replies_owner on comment_replies
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));

create policy leads_owner on leads
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));

create policy objection_library_owner on objection_library
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));
