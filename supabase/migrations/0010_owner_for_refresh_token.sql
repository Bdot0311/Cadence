-- 0010_owner_for_refresh_token.sql
--
-- A refresh token can only be redeemed with the client credentials of the app
-- that issued it (see 0005_two_apps.sql). The worker therefore has to know
-- which owner a token belongs to BEFORE it can pick an OAuth client.
--
-- Matching happens inside the database against the encrypted column so the
-- plaintext token never appears in a query or a statement log.

create or replace function owner_for_refresh_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select a.owner_id into v_owner
  from accounts a
  where a.refresh_token_enc is not null
    and app_decrypt(a.refresh_token_enc) = p_token
  limit 1;
  return v_owner;
end;
$$;

revoke all on function owner_for_refresh_token from public;
revoke all on function owner_for_refresh_token from authenticated;
grant execute on function owner_for_refresh_token to service_role;
