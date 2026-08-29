-- 0012_credential_rpc_secret.sql
--
-- Removes the credential RPCs' dependency on the `app.token_encryption_key`
-- DATABASE SETTING.
--
-- WHY
--
-- 0006/0009 encrypted BYOK credentials with app_encrypt(), which reads
-- current_setting('app.token_encryption_key'). That setting is applied by hand
-- with ALTER DATABASE and had never been applied to this project, so every call
-- to set_user_credentials failed with:
--
--   42704  unrecognized configuration parameter "app.token_encryption_key"
--
-- The LinkedIn token RPCs never had this problem because they take the secret
-- as an ARGUMENT (see save_account_tokens / get_account_tokens). That is why
-- publishing worked while BYOK did not.
--
-- Passing the secret in is also the only version that survives a change of
-- Supabase project: connecting the app to a new project copies the schema, but
-- it does not copy a database-level GUC, so the GUC version breaks silently on
-- exactly the day the app moves. These two functions now match the token RPCs.
--
-- The secret still never lands in a table and never reaches the browser: the
-- API and worker hold it in process env and pass it per call.

-- Drop the GUC-based signatures outright rather than leaving them as overloads.
-- An overload set where one member silently fails is worse than no overload.
drop function if exists public.set_user_credentials(uuid, text, text, text, text, text, text, text);
drop function if exists public.get_user_credentials(uuid);

create or replace function public.set_user_credentials(
  p_owner uuid,
  p_encryption_secret text,
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

  if p_encryption_secret is null or length(p_encryption_secret) < 32 then
    raise exception 'encryption secret missing or too short';
  end if;

  insert into user_credentials as uc (owner_id) values (p_owner)
  on conflict (owner_id) do nothing;

  -- Null means "leave unchanged", so the settings screen can save one field
  -- without the user re-entering every secret. Empty string clears.
  update user_credentials set
    anthropic_api_key_enc = case
      when p_anthropic_key is null then anthropic_api_key_enc
      when p_anthropic_key = '' then null
      else extensions.pgp_sym_encrypt(p_anthropic_key, p_encryption_secret) end,
    anthropic_model  = coalesce(p_anthropic_model, anthropic_model),
    anthropic_effort = coalesce(p_anthropic_effort, anthropic_effort),
    linkedin_client_id = case
      when p_li_client_id is null then linkedin_client_id
      when p_li_client_id = '' then null
      else p_li_client_id end,
    linkedin_client_secret_enc = case
      when p_li_client_secret is null then linkedin_client_secret_enc
      when p_li_client_secret = '' then null
      else extensions.pgp_sym_encrypt(p_li_client_secret, p_encryption_secret) end,
    linkedin_cma_client_id = case
      when p_cma_client_id is null then linkedin_cma_client_id
      when p_cma_client_id = '' then null
      else p_cma_client_id end,
    linkedin_cma_client_secret_enc = case
      when p_cma_client_secret is null then linkedin_cma_client_secret_enc
      when p_cma_client_secret = '' then null
      else extensions.pgp_sym_encrypt(p_cma_client_secret, p_encryption_secret) end
  where owner_id = p_owner;
end;
$$;

revoke all on function public.set_user_credentials(uuid, text, text, text, text, text, text, text, text) from public;
grant execute on function public.set_user_credentials(uuid, text, text, text, text, text, text, text, text) to authenticated;

-- Service role only. A signed-in browser must never read back a decrypted
-- secret, including its own.
create or replace function public.get_user_credentials(
  p_owner uuid,
  p_encryption_secret text
)
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
    case when uc.anthropic_api_key_enc is null then null
         else extensions.pgp_sym_decrypt(uc.anthropic_api_key_enc, p_encryption_secret) end,
    uc.anthropic_model,
    uc.anthropic_effort,
    uc.linkedin_client_id,
    case when uc.linkedin_client_secret_enc is null then null
         else extensions.pgp_sym_decrypt(uc.linkedin_client_secret_enc, p_encryption_secret) end,
    uc.linkedin_cma_client_id,
    case when uc.linkedin_cma_client_secret_enc is null then null
         else extensions.pgp_sym_decrypt(uc.linkedin_cma_client_secret_enc, p_encryption_secret) end
  from user_credentials uc
  where uc.owner_id = p_owner;
end;
$$;

revoke all on function public.get_user_credentials(uuid, text) from public;
revoke all on function public.get_user_credentials(uuid, text) from authenticated;
grant execute on function public.get_user_credentials(uuid, text) to service_role;
