# LIMITS.md

What this agent can and cannot do, and why. Written so future-me doesn't spend a
day trying to make it send DMs.

Verified against the LinkedIn API surface as of **August 2026**. If you're reading
this more than ~6 months out, re-verify before trusting the "cannot" column —
LinkedIn moves products between tiers. The "will not" column does not expire.

---

## The three categories

There are three different reasons something isn't in this agent, and conflating
them is how people end up building things that get their account restricted.

| Category | Meaning | Changes over time? |
|---|---|---|
| **CAN** | Supported by the official API at a tier we hold. Built. | Grows |
| **CANNOT** | Not offered by the official API at any tier we can self-serve. | Might change |
| **WILL NOT** | Technically possible via unsanctioned means. Deliberately excluded. | Never changes |

The **WILL NOT** list is a product decision, not a technical gap. Don't "fix" it.

---

## v1 scope — personal profile only

**Decided 2026-08-15.** v1 ships against `w_member_social` + Sign In with LinkedIn
(OpenID Connect) only. Both are self-serve Open Permissions — request the product,
get it, publish the same day.

Community Management API is **out of v1**. It requires LinkedIn's review including
a screencast of a working integration, and everything it gates is deferred with it.

### CAN — built, running on sanctioned APIs

| Capability | Scope / product | Where it lives |
|---|---|---|
| Publish to the founder's personal profile | `w_member_social` (Open Permission, self-serve) | `worker/` scheduler → `POST /rest/posts` |
| Upload and attach images / video | `/rest/images`, `/rest/videos` → returns URN, referenced in the post | `packages/linkedin-client` |
| Identify the authenticated member + author URN | Sign In with LinkedIn using OpenID Connect | setup wizard |

That is the entire v1 API surface. It is **write-only**. There are no read
endpoints at this tier — the agent cannot see its own impressions, comments, or
reactions, and has no feedback signal from LinkedIn whatsoever.

### Deferred to v2, behind Community Management API approval

Code paths for these are **not** built in v1. They land as a unit when CMA
approval does.

| Deferred capability | Scope / product |
|---|---|
| Publish to company pages | `w_organization_social` |
| Read comments and reactions on posts we authored | `r_organization_social` + socialActions |
| Reply to comments on our own org's posts | Comments API via socialActions |
| Real-time engagement events on our pages | Organization Social Action Notifications (webhooks) |
| Post, page, and follower analytics | Community Management analytics endpoints |
| `@mention` followers in org posts | People Typeahead API |
| Discover every org the founder administers | Organization Access Control endpoint |

**Consequence — the engagement loop does not exist in v1.** Comment reading and
replying are org-scoped. No webhooks, no classification, no auto-replies.

**Consequence — the learning loop has no automated input.** Post analytics are
CMA-gated, so nothing feeds `performance` from the API. The Phase 7 machinery is
built anyway (pillar-mix adjustment, 15%/week cap) and fed by a manual
metrics-entry form in the dashboard, since LinkedIn's own UI is the only
sanctioned place those numbers exist. When CMA approval lands, swap the input
source and the rest is unchanged.

**Consequence — DM handling is dropped entirely.** See below.

---

## CANNOT — no path at any self-serve tier

These are hard gaps in the official API. Each one has a corresponding "someone on
the internet says you can do this with a headless browser" answer. See WILL NOT.

### Sending direct messages — and reading them

The Messages API is **partner-gated**, and even for approved partners it only
covers member-to-member messaging between existing 1st-degree connections. There
is no application path that gets a solo founder programmatic DM sending.

The gate applies to **reading as well as sending**. This is the part that's easy
to miss, and it's why the original "draft replies into a queue" design doesn't
survive contact with the API: a draft queue needs inbound threads to draft
against, and there is no sanctioned way to obtain them. The only ideas that work
are parsing LinkedIn's own notification emails (which truncate message bodies) or
manual paste (which adds a recurring manual action rather than removing one).

**Decision (2026-08-15): DM handling is dropped from v1 entirely.** No
`dm_drafts` table, no queue UI, no leads table. Revisit only if LinkedIn opens
the Messages API at a self-serve tier.

If you are reading this because you're about to build a DM feature: check whether
the Messages API has actually changed tier. If it hasn't, the answer is still no,
and the reason is in WILL NOT below.

### Reading the main feed

No endpoint returns the member's home feed. The agent cannot see, react to, or
comment on posts that aren't ours.

### Commenting on other people's posts

Follows from the above. We can only interact with socialActions on content our
own authenticated entities authored.

### Searching for or looking up arbitrary member profiles

No people-search endpoint at self-serve tier. People Typeahead is scoped to
mentioning **our own followers inside an org post** — it is not a lookup API and
cannot be used for prospecting.

### Sending connection requests

No endpoint. Network growth is manual or organic.

### Reading analytics for posts we did not author

Analytics is scoped to our own member and org content.

---

## WILL NOT — deliberately excluded

The following are technically achievable and are **not** going into this repo, in
any branch, behind any feature flag, under any name:

- Headless-browser drivers of a logged-in session
- Cookie or `li_at` session reuse / hijacking
- Anti-detect browser profiles
- Residential proxy rotation
- Browser-fingerprint spoofing
- Synthetic mouse-movement or typing simulation
- Third-party "LinkedIn automation" APIs that do any of the above under the hood

**Why.** All of them violate the LinkedIn User Agreement and carry real risk of
permanent account restriction. For this founder that means losing the personal
profile *and* the company page — the primary distribution channel — in one shot.
The entire premise of building on the sanctioned API is that the agent can run
flat out for years without anyone worrying about it. A capability that trades that
away is a net loss no matter how useful it looks in isolation.

**If a future contributor (human or agent) proposes one of these:** the answer is
no, and the reason is not "we haven't gotten to it yet."

Note that this rules out third-party vendors too, which is the easier one to miss.
A hosted API that offers "LinkedIn DM sending" is driving a logged-in session
somewhere. The risk lands on our account either way.

---

## Pacing — why the scheduler is slow on purpose

The scheduler enforces publishing windows, minimum spacing between posts on the
same account, daily and weekly caps, and a randomized few-minute offset inside the
target window.

**The reason is engagement quality, not detection evasion.** Six posts fired at
03:14 perform badly and read as spam to actual humans. Posts land when the
audience is awake or they don't land at all. That's the whole argument.

Separately and for a different reason, the client is a well-behaved API consumer:
it reads rate-limit headers on every response, writes them to `rate_ledger`, backs
off exponentially with jitter on 429/503, and pauses an account for the day if it
trips a limit twice within an hour. That's ordinary good client hygiene, the same
as we'd write against any vendor's API.

These two things share a code path but not a rationale. Keep them documented
separately so nobody later "optimizes" the human-timing rules on the theory that
they were about throttles.

**Naming rule:** no module, variable, or comment in this repo is named `stealth`,
`evade`, `humanize-fingerprint`, or any relative. Not because the words are
forbidden but because they'd describe something we aren't doing, and six months
from now that misdescription is what someone would act on.

---

## Rate and quota ceilings to design against

- **Personal profile writes: ~100/day/member.** Budget the ledger against this
  ceiling with headroom. Do not discover it by hitting it.
- Org-level limits vary by product tier and are reported in response headers —
  the ledger records them rather than hardcoding them.
- `access_token`: 60-day lifetime. `refresh_token`: 365-day lifetime. The refresh
  job renews at T-7 days and emails on failure. **When the refresh token expires
  at 365 days, re-auth is manual.** Put a calendar reminder at day 350; there is
  no programmatic escape from this one.
- API version pinning: `LinkedIn-Version` header in `YYYYMM` format, sent on every
  request. Bumping it is a deliberate, tested change, not a default.

---

## Approval gates — an open conflict, flagged

`company-context` states that every agent drafts or recommends and the founder is
the only one who ships, with **"posting or publishing anything (LinkedIn, X,
Reddit, blog, site)"** named explicitly as a stop-and-ask gate.

This agent's spec overrides that for LinkedIn: it publishes autonomously, and the
only human involvement after setup is reading the dashboard.

That override is intentional and it is the founder's call. It is recorded here
because the two documents otherwise contradict each other, and because the
override is narrow — it covers **publishing to LinkedIn surfaces this agent owns**
and nothing else. It does not extend to X, Reddit, the blog, the site, spend,
pricing, or merges to main.

The compromise in the build: `AGENT_AUTONOMY_MODE` supports `autonomous` and
`approval_queue`. Dry-run mode (`approval_queue` behavior, no publishes) is the
default for the first 7 days after install, so the gate is real until the founder
has watched the slop gate work and explicitly flips it.

---

## Things that look like limits but aren't

- **"Long posts get suppressed."** No evidence for this in our own analytics.
  Long-form is fine and frequently better. The content engine does not cap length.
- **"External links kill reach."** The CTA policy avoids external links for
  reasons of conversion design (comment-gate mechanic, drive to signup), not
  because of an algorithmic penalty we've measured. Don't launder a strategy
  choice into a platform constraint.

If either of these turns out to be measurable in `performance`, update this
section with the actual numbers. Until then they stay in the "unverified folklore"
bucket.

---

## Product facts the agent must never contradict

Sourced from `company-context`. These are enforced at the fact gate, not left to
the model's judgment:

- **Outreign is email outbound only.** No calls, no dialing, no voice features.
  Ever. Any draft implying otherwise is rejected outright, not softened.
- The **AI SDR agent is live** — describe it as shipped, not planned.
- **Not yet built, never claim as live:** ICP Builder, Unified Inbox,
  Deliverability Dashboard, Signal Lead Queue, Email Quality Checker.
- CRM sync: **Gmail is live**; HubSpot and Salesforce are "shipping soon."
- **Never name the underlying lead-data provider.** Always: "verified contacts
  from public records and licensed data partnerships" and "live intent signals."
- **Never mention** DreamScape Events NY, Kora AI, or any credit-analysis work.
  These are not part of the portfolio and appear in no draft.
- **No fabricated metrics, testimonials, or claims.** If a number isn't real it
  doesn't ship. Unverifiable product claims are **cut**, not hedged.

---

## Where each limit is enforced in code

| Limit | Enforcement point |
|---|---|
| No DM sending or reading | No message path of any kind exists in `packages/linkedin-client`. |
| No org / page writes in v1 | `packages/linkedin-client` exposes only member-authored posts. |
| Daily / weekly caps, windows, spacing | `worker/src/jobs/scheduler.ts`, config-driven |
| Personal-profile 100/day ceiling | `rate_ledger` pre-flight check before every write |
| Backoff and account pause | `packages/linkedin-client` response interceptor |
| Product-fact claims | Fact gate, `packages/content-engine/src/pipeline/fact-gate.ts` |
| AI writing tells | Slop gate, same directory, max 3 loops then kill |
| Kill switch | `AGENT_KILL_SWITCH` env var + dashboard button, checked every scheduler tick |
| Anomaly halt | >20% publish failures in a rolling hour, or any 401/403 |

---

## v2 status — code built, scopes pending

The Community Management API capabilities listed as deferred above now have
**working code paths**, tested against fixtures. They are not live. Nothing
changes about what the agent can actually do until LinkedIn grants the scopes.

| Capability | Code | Live |
|---|---|---|
| Publish to company pages | Built (`Posts.create` accepts an org URN) | No |
| Read comments on our posts | Built (`SocialActions.listComments`) | No |
| Reply to comments | Built (`SocialActions.replyToComment`) | No |
| Org discovery | Built (`Organizations.listAdministered`) | No |
| Post analytics | Built (`Organizations.shareStatistics`) | No |
| Engagement routing and timing | Built (`comment-policy.ts`, 20 tests) | No |
| Engagement tables | Migration `0004_engagement.sql` | Applied, empty |

**Two conditions gate all of it**, both required, checked before any request is
built:

1. `ORG_FEATURES_ENABLED=true`
2. The account token actually carries the needed scope

The second condition is the one that matters. A flag alone would let a config
change start firing requests that come back 403, which trips the anomaly halt
and stops personal-profile publishing that was working fine. Checking the
granted scope turns that into a clear local error instead.

Adding the product in the LinkedIn developer console does **not** upgrade an
existing token. The account has to be reconnected so OAuth re-runs with the new
scope. That is the most likely reason the gate stays shut after approval lands,
so the error message says so directly.

### Rules encoded in the engagement loop

These are deterministic, not left to model judgment:

- **The agent never argues.** Hostile comments are logged and left alone. There
  is no configuration that turns this off, and a test asserts that both
  objection-library states still produce silence.
- **An objection with no library entry gets no reply.** Improvising a rebuttal
  in public is the same failure as arguing.
- **Never a second reply in a thread** unless the person asked a direct
  follow-up after ours.
- **Never a reply outside active hours.** A reply that lands overnight is pushed
  to the next opening rather than dropped or sent at 4am.
- **Replies are held 20 to 90 minutes.** Instant replies read as automation.

### What is still impossible

DMs remain out, for reading and sending both. That did not change and will not
change without LinkedIn opening the Messages API at a self-serve tier. The
WILL NOT list above is unchanged in full.
