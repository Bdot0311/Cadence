-- 0009_credential_rpc.sql
--
-- Encryption happens inside the database, so a plaintext credential never
-- exists in the API process beyond the request that carried it, and the
-- encryption key never leaves Postgres.

-- Called by the API on behalf of the signed-in user. SECURITY DEFINER so it can
-- reach app_encrypt, but it writes ONLY to the caller's own row: p_owner is
-- checked against auth.uid() rather than trusted from the argument.
create or replace function set_user_credentials(
  p_owner uuid,
  p_anthropic_key text default null,
  p_anthropic_model text default null,
  p_anthropic_effort text default null,
  p_li_client_id text default null,
  p_li_client_secret text default null,
  p_cma_client_id text default null,
  p_cma_client_secret text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and auth.uid() <> p_owner then
    raise exception 'cannot write credentials for another user';
  end if;

  insert into user_credentials as uc (owner_id) values (p_owner)
  on conflict (owner_id) do nothing;

  -- Null means "leave unchanged", so the settings screen can save one field
  -- without the user re-entering every secret. Empty string clears.
  update user_credentials set
    anthropic_api_key_enc = case
      when p_anthropic_key is null then anthropic_api_key_enc
      when p_anthropic_key = '' then null
      else app_encrypt(p_anthropic_key) end,
    anthropic_model  = coalesce(p_anthropic_model, anthropic_model),
    anthropic_effort = coalesce(p_anthropic_effort, anthropic_effort),
    linkedin_client_id = case
      when p_li_client_id is null then linkedin_client_id
      when p_li_client_id = '' then null
      else p_li_client_id end,
    linkedin_client_secret_enc = case
      when p_li_client_secret is null then linkedin_client_secret_enc
      when p_li_client_secret = '' then null
      else app_encrypt(p_li_client_secret) end,
    linkedin_cma_client_id = case
      when p_cma_client_id is null then linkedin_cma_client_id
      when p_cma_client_id = '' then null
      else p_cma_client_id end,
    linkedin_cma_client_secret_enc = case
      when p_cma_client_secret is null then linkedin_cma_client_secret_enc
      when p_cma_client_secret = '' then null
      else app_encrypt(p_cma_client_secret) end
  where owner_id = p_owner;
end;
$$;

revoke all on function set_user_credentials from public;
grant execute on function set_user_credentials to authenticated;

-- Called by the WORKER with the service role only. Never granted to
-- authenticated: a signed-in browser must never be able to read back a
-- decrypted secret, including its own.
create or replace function get_user_credentials(p_owner uuid)
returns table (
  anthropic_api_key text,
  anthropic_model text,
  anthropic_effort text,
  linkedin_client_id text,
  linkedin_client_secret text,
  linkedin_cma_client_id text,
  linkedin_cma_client_secret text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    app_decrypt(uc.anthropic_api_key_enc),
    uc.anthropic_model,
    uc.anthropic_effort,
    uc.linkedin_client_id,
    app_decrypt(uc.linkedin_client_secret_enc),
    uc.linkedin_cma_client_id,
    app_decrypt(uc.linkedin_cma_client_secret_enc)
  from user_credentials uc
  where uc.owner_id = p_owner;
end;
$$;

revoke all on function get_user_credentials from public;
revoke all on function get_user_credentials from authenticated;
grant execute on function get_user_credentials to service_role;
