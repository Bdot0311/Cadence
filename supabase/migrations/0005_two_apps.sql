-- 0005_two_apps.sql — record which LinkedIn app issued each account's token.
--
-- WHY THIS EXISTS
--
-- Community Management API requires that it be the ONLY product on a LinkedIn
-- developer app, "for legal and security reasons". It cannot share an app with
-- Share on LinkedIn or Sign In with LinkedIn — the developer console greys out
-- the request button when any other product is provisioned or pending.
--
-- So holding both capabilities means two apps, two client ID/secret pairs, and
-- two independent OAuth flows.
--
-- The failure this column prevents: a refresh token can only be redeemed with
-- the client credentials of the app that ISSUED it. Refreshing a Community
-- token with the primary app's client_id comes back as invalid_grant, which
-- looks like an expired token rather than a config error, and the refresh job
-- would happily "retry" it daily until the 365-day wall. Storing the issuing
-- app makes the pairing explicit.

create type linkedin_app_id as enum ('primary', 'community');

alter table accounts
  add column linkedin_app linkedin_app_id not null default 'primary';

comment on column accounts.linkedin_app is
  'Which LinkedIn developer app issued this account''s tokens. Refresh MUST use '
  'the matching client credentials — see packages/linkedin-client/src/apps.ts.';

-- Every pre-existing account was created before the split, by the original
-- single app. 'primary' is correct for them, not merely a convenient default,
-- which is why the column defaults rather than being backfilled conditionally.

-- An account is identified by its URN plus the app that authorised it. The same
-- company page could in principle be connected under both apps during a
-- migration, and that must not collide.
alter table accounts drop constraint if exists accounts_owner_id_urn_key;
alter table accounts
  add constraint accounts_owner_urn_app_key unique (owner_id, urn, linkedin_app);

-- Publishing to a page and reading its engagement come from different apps, so
-- the dashboard needs to know which capabilities are actually reachable for a
-- given page rather than assuming one token covers both.
create or replace view account_capabilities as
select
  a.id as account_id,
  a.account_type,
  a.linkedin_app,
  a.urn,
  'w_member_social' = any(a.scopes)        as can_publish_member,
  'w_organization_social' = any(a.scopes)  as can_publish_org,
  'r_organization_social' = any(a.scopes)  as can_read_engagement
from accounts a;

create index accounts_app_idx on accounts (owner_id, linkedin_app) where active;
