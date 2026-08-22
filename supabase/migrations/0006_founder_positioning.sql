-- 0006_founder_positioning.sql
--
-- Applies the LinkedIn audit (Aug 2026). Its six findings reduce to one
-- structural problem: the content is product-first, and Cadence was ENFORCING
-- that rather than merely permitting it.
--
-- Two mechanisms were doing the enforcing:
--
--   1. All five content pillars were product-domain. There was no pillar a
--      founder-perspective post could be filed under, so the selection step
--      could never choose one.
--   2. cta_policy was global comment_gate. Every post ended asking for a
--      signup, which is the audit's "every post follows problem -> lesson ->
--      product -> CTA" verbatim.
--
-- This migration makes founder-led content representable and lets the CTA vary
-- by pillar. It does not invent the founder's beliefs; see founder_pov.

-- ---------------------------------------------------------------------------
-- pillar kind + per-pillar CTA
-- ---------------------------------------------------------------------------

create type pillar_kind as enum ('founder', 'product');

alter table content_pillars
  add column kind pillar_kind not null default 'product',
  -- Overrides agent_config.cta_policy.mechanic for this pillar. Null inherits.
  add column cta_mechanic text;

comment on column content_pillars.kind is
  'founder = the post is about the operator''s thinking, with the product used '
  'only as proof. product = the product or its domain is the subject.';

comment on column content_pillars.cta_mechanic is
  'Per-pillar CTA override. Founder pillars use discussion rather than '
  'comment_gate so thought-leadership does not close on a signup ask.';

-- ---------------------------------------------------------------------------
-- founder_pov — the beliefs the audit asks for
-- ---------------------------------------------------------------------------
-- The audit says: "Develop 3-5 strong beliefs around founder-led growth and
-- sales infrastructure" and "turn those beliefs into contrarian posts and
-- recurring content themes".
--
-- These are DELIBERATELY not seeded. A belief the agent invented is not the
-- founder's point of view, and company-context forbids fabricated claims. The
-- table ships empty and the drafting step degrades gracefully until it is
-- filled in.

create table founder_pov (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references accounts(id) on delete cascade,

  -- Short name for the belief, used as a recurring theme label.
  label       text not null,
  -- The belief itself, first person, as the founder would state it.
  belief      text not null,
  -- What common assumption this pushes against. The audit's core complaint is
  -- that the content explains best practices instead of challenging them, so
  -- the contrarian edge is a first-class field rather than an afterthought.
  challenges  text,
  -- Concrete experience backing it. Keeps a belief from reading as a slogan.
  evidence    text,

  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (account_id, label)
);

create trigger founder_pov_updated_at before update on founder_pov
  for each row execute function set_updated_at();

alter table founder_pov enable row level security;

create policy founder_pov_owner on founder_pov
  for all to authenticated
  using (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()))
  with check (exists (select 1 from accounts a where a.id = account_id and a.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- primary audience
-- ---------------------------------------------------------------------------
-- Audit finding 4: the content attracts ops managers, SDRs and product users
-- rather than the decision makers. Drafting had no audience concept at all, so
-- it defaulted to whoever the product serves.

alter table agent_config
  add column primary_audience text
    not null default 'Founders, CEOs, and sales leaders at B2B companies',
  add column secondary_audience text
    not null default 'Sales ops managers and SDRs who use outbound tooling';
