-- 0008_per_user_credentials.sql
--
-- Makes the app safe to share. Until now BYOK credentials were written to the
-- SERVER'S .env file (api/src/env-file.ts) and the worker read one global
-- ANTHROPIC_API_KEY and one LINKEDIN_CLIENT_ID at boot.
--
-- With two signed-up users that means the second user's save overwrites the
-- first's, and the worker then publishes for EVERYONE using whichever key was
-- saved last. RLS already isolates the data; it never isolated the credentials.
--
-- Credentials move here, encrypted at rest with the same pgcrypto helpers as
-- the LinkedIn tokens, scoped to the owner rather than to the process.

create table user_credentials (
  owner_id uuid primary key references auth.users(id) on delete cascade,

  -- Anthropic. Per user: they bring their own key and pay for their own usage.
  anthropic_api_key_enc bytea,
  anthropic_model       text not null default 'claude-sonnet-5',
  anthropic_effort      text not null default 'high',

  -- The user's own LinkedIn developer app. Two users must not share one app:
  -- LinkedIn rate limits per app, and a shared client_id means one user's
  -- throttling pauses everyone.
  linkedin_client_id        text,
  linkedin_client_secret_enc bytea,

  -- Community Management app, when they have one. Separate app by LinkedIn's
  -- own rule; see 0005_two_apps.sql.
  linkedin_cma_client_id        text,
  linkedin_cma_client_secret_enc bytea,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_credentials_updated_at before update on user_credentials
  for each row execute function set_updated_at();

alter table user_credentials enable row level security;

-- A user may write their own credentials and read whether they are SET, but the
-- decrypted values are never exposed through the API — the columns are bytea
-- and the dashboard only ever receives booleans. The worker reads them with the
-- service role.
create policy user_credentials_owner on user_credentials
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Convenience view for the settings screen: which credentials exist, without
-- returning any of them.
create or replace view user_credential_status as
select
  owner_id,
  anthropic_api_key_enc is not null          as anthropic_configured,
  linkedin_client_id is not null
    and linkedin_client_secret_enc is not null as linkedin_configured,
  linkedin_cma_client_id is not null
    and linkedin_cma_client_secret_enc is not null as linkedin_cma_configured,
  anthropic_model,
  anthropic_effort
from user_credentials;
