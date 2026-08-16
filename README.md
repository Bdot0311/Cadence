# Autonomous LinkedIn Agent

Writes posts, publishes them on a human cadence, and stays out of your way.
After setup the only thing you do is read the dashboard.

**Read [LIMITS.md](LIMITS.md) first.** It documents what this agent can and
cannot do and why, including several things that look like gaps but are
deliberate. It will save you a day.

---

## What v1 is

Autonomous content generation, editorial gating, scheduling, and publishing to
**your personal LinkedIn profile**.

Built on `w_member_social` + Sign In with LinkedIn (OpenID Connect). Both are
self-serve Open Permissions — you request the product and you have it the same
day. No approval queue, no screencast, no waiting.

**Not in v1:** company pages, the engagement loop (comment reading and
replying), and DM handling. The first two need Community Management API
approval; the third has no sanctioned API at any tier. See LIMITS.md for the
reasoning and for what changes when CMA approval lands.

---

## Architecture

```
supabase/migrations/     8 tables, RLS on all, pgcrypto for tokens

packages/
  linkedin-client/       Sanctioned API client. Ledgers every call, gates every
                         write, backs off on 429/503, halts on 401/403.
  content-engine/        Ideation → selection → drafting → slop gate → fact gate.

worker/                  Scheduler tick, token refresh, digest. Runs on cron.
api/                     OAuth callback, setup wizard, dashboard backend.
dashboard/               React + Vite operator control room.
```

The two gates are the point of the whole system. A killed draft is a better
outcome than a mediocre published one, so the pipeline gives up after three
attempts rather than lowering the bar, and records exactly why.

---

## Setup

Target is under 30 minutes from clone to connected.

### 1. Prerequisites

- Node 20+
- A Supabase project
- An Anthropic API key
- A LinkedIn account you're willing to publish from

### 2. Install

```bash
npm install
cp .env.example .env
```

Fill in `.env` as you work through the steps below. Every variable is documented
in place, including the ones with traps.

### 3. Create the LinkedIn app

Go to <https://www.linkedin.com/developers/apps> and create an app.

**Request exactly these two products** on the Products tab:

| Product | Why | Approval |
|---|---|---|
| **Share on LinkedIn** | Grants `w_member_social` — publishing to your profile | Self-serve, instant |
| **Sign In with LinkedIn using OpenID Connect** | Grants `openid profile email` — resolves your author URN | Self-serve, instant |

Do **not** request Community Management API for v1. It gates capabilities this
version doesn't use, and requesting it adds a review cycle for nothing. The
justification text and screencast requirements for it are in
[docs/community-management-application.md](docs/community-management-application.md)
for when you want v2.

On the **Auth** tab, add your redirect URL:

```
http://localhost:8080/auth/linkedin/callback
```

It must match `LINKEDIN_REDIRECT_URI` byte for byte, trailing slash included. A
mismatch fails OAuth with an unhelpful error.

Copy the Client ID and Client Secret into `.env`.

### 4. Set the API version

```
LINKEDIN_API_VERSION=202608
```

`YYYYMM`, sent on every `/rest` request. **Verify this against the developer
portal before your first live run** — LinkedIn does not publish a version every
month, and a value they don't recognise fails every call. Bumping it later is a
deliberate, tested change; LinkedIn ships breaking changes between versions.

### 5. Database

```bash
supabase db push
```

Then set the token encryption key. Generate one, put the same value in both
places:

```bash
openssl rand -base64 32
```

```sql
ALTER DATABASE postgres SET app.token_encryption_key = '<value>';
```

```
TOKEN_ENCRYPTION_KEY=<same value>
```

Rotating this later means re-encrypting every stored token by hand. There is no
migration that does it for you.

### 6. Run the setup wizard

```bash
npm run dev
```

Open the dashboard and work through the wizard:

1. **Connect LinkedIn** — OAuth round trip. Tokens are stored encrypted; your
   author URN is resolved and written to `accounts`.
2. **Voice calibration** — paste 10 to 20 of your best-performing past posts.
   The agent extracts sentence-length distribution, opener patterns, vocabulary,
   structural habits, and line-break style into a versioned JSON profile that
   every generation call loads. This is what stops output from drifting into
   generic LinkedIn voice, and it's the step most worth doing properly.
3. **Content pillars** — name them, describe them, set target share of output.
4. **Strategy config** — posting windows in your timezone, daily and weekly
   caps, minimum gap, CTA policy, blocked topics and claims.

### 7. Watch it for a week

**The agent runs in dry-run mode for the first 7 days.** The full pipeline runs
and everything is logged, but nothing publishes. This is enforced at the
database level (`agent_config.dry_run_until`), so no env var can shorten it.

Use that week to read the daily digest and check the killed-drafts view. If the
gates are killing things you'd have shipped, tune the voice profile before you
go live rather than after.

When you're satisfied, flip `autonomy_mode` to `autonomous` in the dashboard.

### Runtime commands

```bash
npm run dev       # API on :8080 and dashboard on :5173
npm run worker    # scheduler, daily refresh, alerts, and digest
```

The worker and API use the service-role key; the browser never receives it.
The dashboard signs users in through Supabase Auth and sends that short-lived
session token to the API. Run `supabase db push` after pulling changes so the
runtime token RPCs and dashboard kill switch from `0002_runtime.sql` exist.

---

## Operating it

### The kill switch

Two independent switches, either of which halts all outbound writes:

```bash
AGENT_KILL_SWITCH=true    # env
```

...or the dashboard button. Both take effect within one scheduler tick (15
minutes by default), and the tick checks them before it loads a single account.

The env var is the one that still works when the database is the thing that
broke. Use it during an incident.

### The daily digest

Emailed to `ALERT_EMAIL_TO`. What published, what got killed at the gates and
why, engagement summary, quota consumption, and anything that errored.

### When it stops on its own

| Trigger | Behaviour |
|---|---|
| Rate limited twice in an hour | That account pauses for the rest of the day |
| Publish failures over 20% in a rolling hour | All writes halt, you get an email |
| Any 401 or 403 | All writes halt immediately — retrying a revoked token is pointless |
| Daily write budget hit | Writes stop until tomorrow |

None of these retry blindly. Each one emails you.

### The 365-day wall

Your refresh token expires 365 days after you connect. Renewing it **requires
you to reconnect by hand** — there is no programmatic path. The agent warns 30
days out and deactivates itself when the token lapses rather than failing
silently.

Put a calendar reminder at day 350.

---

## Testing

```bash
npm test          # 169 tests
npm run typecheck
```

The suite covers the acceptance criteria that can be verified without a live
LinkedIn connection:

| Criterion | Where |
|---|---|
| Gate has teeth | `packages/content-engine/src/{detectors,pipeline}.test.ts` |
| Forced throttle → backoff and account pause | `packages/linkedin-client/src/http.test.ts`, `worker/src/lib/guard.test.ts` |
| Token refresh, clock fast-forwarded 60 days | `worker/src/jobs/refresh-tokens.test.ts` |
| Kill switch halts within one tick | `worker/src/jobs/scheduler.test.ts` |

Two criteria are operational and can't be asserted in CI: the wizard finishing
under 30 minutes, and 14 consecutive days of unattended publishing.

---

## Things that will bite you

- **`LINKEDIN_API_VERSION`** — verify it exists before the first live run.
- **`SUPABASE_SERVICE_ROLE_KEY`** — server-side only. If it reaches the browser
  bundle, rotate it immediately.
- **`TOKEN_ENCRYPTION_KEY`** — must be set in `.env` *and* on the database.
- **Redirect URI** — byte-for-byte, including the trailing slash.
- **Minimum gap dominates the daily cap.** With a 240-minute gap, two posts
  cannot go out in the same tick no matter what `daily_cap` says. That's the
  pacing rule working, not a bug.
