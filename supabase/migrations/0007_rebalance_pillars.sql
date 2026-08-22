-- 0007_rebalance_pillars.sql
--
-- Audit finding 2: "Create a 50/50 mix of thought leadership and product
-- related content." Before this, all five pillars were product-domain, which
-- meant the selection step had nowhere to file a founder-perspective post even
-- if drafting had produced one.
--
-- Shares are set to sum to exactly 1.00. adjustPillarMix renormalises weekly
-- within a 15% cap, so these are a starting point, not a fixed allocation.
--
--   Founder  0.50   POV 0.20 | building in public 0.15 | founder-led growth 0.15
--   Product  0.50   outbound 0.15 | infrastructure 0.15 | deliverability 0.10 | AI ops 0.10

-- Existing product pillars: reclassify and rebalance down from 0.90 to 0.50.
update content_pillars set kind = 'product', cta_mechanic = 'comment_gate',
  target_share = 0.15 where name = 'Outbound strategy';
update content_pillars set kind = 'product', cta_mechanic = 'comment_gate',
  target_share = 0.15 where name = 'Sales infrastructure';
update content_pillars set kind = 'product', cta_mechanic = 'comment_gate',
  target_share = 0.10 where name = 'Deliverability and data';
update content_pillars set kind = 'product', cta_mechanic = 'comment_gate',
  target_share = 0.10 where name = 'AI sales operations';

-- "Building OutReign" becomes founder content rather than product content.
-- The audit does not say to stop building in public; it says to stop making
-- the product the subject. Reframed around decisions, failures and lessons,
-- this is exactly the "experiences, failures, and lessons" the audit asks for.
update content_pillars
set name         = 'Building in public',
    description  = 'Decisions, failures, dead ends and what they cost. The reasoning behind a call, not the feature that came out of it. OutReign appears as evidence, never as the subject.',
    kind         = 'founder',
    cta_mechanic = 'discussion',
    target_share = 0.15
where name = 'Building OutReign';

-- New founder pillars. Descriptions are written from the audit's own language
-- so the intent stays traceable to the source rather than to an invented
-- editorial line.
insert into content_pillars (account_id, name, description, target_share, kind, cta_mechanic, active)
select a.id, v.name, v.description, v.share, v.kind::pillar_kind, v.cta, true
from accounts a
cross join (values
  (
    'Founder POV',
    'A stated belief about founder-led growth or sales infrastructure, argued against the common assumption it contradicts. Challenges a best practice rather than restating one. Draws on founder_pov; if no belief is on file, this pillar produces nothing rather than inventing an opinion.',
    0.20, 'founder', 'discussion'
  ),
  (
    'Founder-led growth',
    'Scaling a company without a team: building revenue infrastructure, deciding what to automate versus own, and growing without chaos. Written for someone carrying the same load, not for someone evaluating a tool.',
    0.15, 'founder', 'discussion'
  )
) as v(name, description, share, kind, cta)
where a.account_type = 'member'
on conflict (account_id, name) do nothing;
