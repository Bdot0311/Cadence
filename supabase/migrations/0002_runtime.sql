-- Runtime wiring: dashboard brake plus narrowly-scoped token RPCs.

alter table agent_config
  add column if not exists kill_switch_engaged boolean not null default false,
  add column if not exists halt_reason text,
  add column if not exists halted_at timestamptz;

create or replace function get_account_tokens(target_account_id uuid)
returns table (access_token text, refresh_token text)
language sql
security definer
set search_path = public
as $$
  select app_decrypt(a.access_token_enc), app_decrypt(a.refresh_token_enc)
  from accounts a
  where a.id = target_account_id;
$$;

create or replace function save_account_tokens(
  target_account_id uuid,
  new_access_token text,
  new_refresh_token text,
  new_token_expires_at timestamptz,
  new_refresh_expires_at timestamptz,
  new_scopes text[]
)
returns void
language sql
security definer
set search_path = public
as $$
  update accounts set
    access_token_enc = app_encrypt(new_access_token),
    refresh_token_enc = case when new_refresh_token is null then refresh_token_enc else app_encrypt(new_refresh_token) end,
    token_expires_at = new_token_expires_at,
    refresh_expires_at = coalesce(new_refresh_expires_at, refresh_expires_at),
    scopes = case when cardinality(new_scopes) = 0 then scopes else new_scopes end,
    updated_at = now()
  where id = target_account_id;
$$;

create or replace function upsert_linkedin_account(
  target_owner_id uuid,
  target_urn text,
  target_display_name text,
  new_access_token text,
  new_refresh_token text,
  new_token_expires_at timestamptz,
  new_refresh_expires_at timestamptz,
  new_scopes text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare result_id uuid;
begin
  insert into accounts (
    owner_id, urn, display_name, access_token_enc, refresh_token_enc,
    token_expires_at, refresh_expires_at, scopes, active
  ) values (
    target_owner_id, target_urn, target_display_name, app_encrypt(new_access_token),
    app_encrypt(new_refresh_token), new_token_expires_at, new_refresh_expires_at,
    new_scopes, true
  )
  on conflict (owner_id, urn) do update set
    display_name = excluded.display_name,
    access_token_enc = excluded.access_token_enc,
    refresh_token_enc = coalesce(excluded.refresh_token_enc, accounts.refresh_token_enc),
    token_expires_at = excluded.token_expires_at,
    refresh_expires_at = coalesce(excluded.refresh_expires_at, accounts.refresh_expires_at),
    scopes = excluded.scopes,
    active = true,
    pause_reason = null,
    paused_until = null
  returning id into result_id;

  insert into agent_config (account_id) values (result_id)
  on conflict (account_id) do nothing;
  return result_id;
end;
$$;

revoke all on function get_account_tokens(uuid) from public, anon, authenticated;
revoke all on function save_account_tokens(uuid, text, text, timestamptz, timestamptz, text[]) from public, anon, authenticated;
revoke all on function upsert_linkedin_account(uuid, text, text, text, text, timestamptz, timestamptz, text[]) from public, anon, authenticated;
grant execute on function get_account_tokens(uuid) to service_role;
grant execute on function save_account_tokens(uuid, text, text, timestamptz, timestamptz, text[]) to service_role;
grant execute on function upsert_linkedin_account(uuid, text, text, text, text, timestamptz, timestamptz, text[]) to service_role;
