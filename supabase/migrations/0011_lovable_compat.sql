-- 20260828120008_lovable_compat.sql
--
-- Makes an existing Cadence Supabase project usable by this app.
--
-- The two schemas grew in different places. This repo's app calls three RPCs
-- and uses an avatars bucket that the standalone Cadence project never had;
-- pointing the app at that project without these returns 404 on connect and on
-- every token read. Verified against the live project: all three were missing
-- and the bucket list was empty.
--
-- Idempotent: safe to run against a project that already has them.

create or replace function public.get_account_tokens(target_account_id uuid, encryption_secret text)
returns table (access_token text, refresh_token text)
language sql security definer set search_path = public as $$
  select
    extensions.pgp_sym_decrypt(a.access_token_enc, encryption_secret),
    case when a.refresh_token_enc is null then null else extensions.pgp_sym_decrypt(a.refresh_token_enc, encryption_secret) end
  from accounts a
  where a.id = target_account_id;
$$;

create or replace function public.save_account_tokens(
  target_account_id uuid,
  new_access_token text,
  new_refresh_token text,
  new_token_expires_at timestamptz,
  new_refresh_expires_at timestamptz,
  new_scopes text[],
  encryption_secret text
)
returns void language sql security definer set search_path = public as $$
  update accounts set
    access_token_enc = extensions.pgp_sym_encrypt(new_access_token, encryption_secret),
    refresh_token_enc = case when new_refresh_token is null then refresh_token_enc else extensions.pgp_sym_encrypt(new_refresh_token, encryption_secret) end,
    token_expires_at = new_token_expires_at,
    refresh_expires_at = coalesce(new_refresh_expires_at, refresh_expires_at),
    scopes = case when cardinality(new_scopes) = 0 then scopes else new_scopes end,
    updated_at = now()
  where id = target_account_id;
$$;

create or replace function public.upsert_linkedin_account(
  target_owner_id uuid,
  target_urn text,
  target_display_name text,
  new_access_token text,
  new_refresh_token text,
  new_token_expires_at timestamptz,
  new_refresh_expires_at timestamptz,
  new_scopes text[],
  encryption_secret text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare result_id uuid;
begin
  if encryption_secret is null or length(encryption_secret) < 32 then
    raise exception 'A token encryption key of at least 32 characters is required';
  end if;

  insert into accounts (
    owner_id, urn, display_name, access_token_enc, refresh_token_enc,
    token_expires_at, refresh_expires_at, scopes, active
  ) values (
    target_owner_id, target_urn, target_display_name, extensions.pgp_sym_encrypt(new_access_token, encryption_secret),
    case when new_refresh_token is null then null else extensions.pgp_sym_encrypt(new_refresh_token, encryption_secret) end,
    new_token_expires_at, new_refresh_expires_at, new_scopes, true
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

create or replace function public.upsert_linkedin_account(
  target_owner_id uuid,
  target_urn text,
  target_display_name text,
  new_access_token text,
  new_refresh_token text,
  new_token_expires_at timestamptz,
  new_refresh_expires_at timestamptz,
  new_scopes text[],
  encryption_secret text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare result_id uuid;
begin
  if encryption_secret is null or length(encryption_secret) < 32 then
    raise exception 'A token encryption key of at least 32 characters is required';
  end if;

  insert into accounts (
    owner_id, urn, display_name, access_token_enc, refresh_token_enc,
    token_expires_at, refresh_expires_at, scopes, active
  ) values (
    target_owner_id, target_urn, target_display_name, extensions.pgp_sym_encrypt(new_access_token, encryption_secret),
    case when new_refresh_token is null then null else extensions.pgp_sym_encrypt(new_refresh_token, encryption_secret) end,
    new_token_expires_at, new_refresh_expires_at, new_scopes, true
  )
  on conflict (owner_id, urn, linkedin_app) do update set
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
-- Avatar storage. Created here rather than through the dashboard so a fresh
-- project is reproducible from migrations alone.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'avatars_public_read'
  ) then
    create policy "avatars_public_read" on storage.objects
      for select using (bucket_id = 'avatars');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'avatars_owner_write'
  ) then
    -- Path convention is <uid>/<file>, so a user can only write under their own
    -- prefix. Without this any authenticated user could overwrite another's.
    create policy "avatars_owner_write" on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;
end $$;
