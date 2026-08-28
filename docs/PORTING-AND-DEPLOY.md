# Porting the Lovable UI into Cadence, and deploying

## What you're actually merging

Not a UI into a backend. Lovable built a **full-stack TanStack Start app** that
contains a *copy* of Cadence's engine:

```
cadence-harmony-flow/src/
  components/          ← the UI you want           (KEEP)
  routes/              ← TanStack routes           (KEEP)
  hooks/  styles.css   ← support                   (KEEP)
  integrations/supabase ← client + generated types (REWIRE)
  lib/content-engine/  ← COPY of packages/content-engine  (DELETE)
  lib/agent/           ← COPY of worker/src        (DELETE)
  server.ts start.ts   ← its own server            (DECIDE)
```

`detectors.ts`, `slop-gate.ts` and `pipeline.ts` are byte-for-byte the same
length as Cadence's, so the copy was taken around 22 Aug. It does **not**
include the per-owner credential work, so treating it as a source of truth
would silently reintroduce the shared-key bug.

**Cadence's `packages/` stay the source of truth. Lovable's `src/lib/` copies
get deleted, not merged.**

## Port recipe

```bash
git clone --depth 1 https://github.com/Bdot0311/cadence-harmony-flow.git /tmp/lovable
cd ~/dev/cadence && git checkout -b port/lovable-ui
```

1. **Take the UI only.**

   ```bash
   rm -rf dashboard/src
   mkdir -p dashboard/src
   cp -R /tmp/lovable/src/{components,hooks,routes,styles.css,router.tsx} dashboard/src/
   cp -R /tmp/lovable/src/integrations dashboard/src/
   cp /tmp/lovable/components.json /tmp/lovable/tsconfig.json dashboard/
   ```

   Do **not** copy `src/lib/content-engine`, `src/lib/agent`, or `.env`.

2. **Merge dependencies.** Lovable pulls ~54 packages (Radix, TanStack Router,
   Tailwind). Merge its `dependencies` into `dashboard/package.json`, keep
   Cadence's workspace protocol for `@agent/*`, then `npm install` from the
   repo root so the workspace resolves.

3. **Rewire the Supabase client.** `dashboard/src/integrations/supabase/client.ts`
   reads `VITE_SUPABASE_*`. Point those at Cadence's project. Regenerate types
   against Cadence's schema, which is 9 migrations ahead of Lovable's:

   ```bash
   supabase gen types typescript --project-id <cadence-ref> \
     > dashboard/src/integrations/supabase/types.ts
   ```

4. **Reconnect anything that imported the deleted copies.** Any
   `from '@/lib/content-engine'` becomes `from '@agent/content-engine'`. The
   workspace already exposes it.

5. **Decide on `server.ts`.** Lovable's TanStack server overlaps Cadence's
   `api/`. Keep Cadence's — it holds the auth checks, the credential RPC calls,
   and the owner scoping. Delete Lovable's and have its routes call the existing
   `/api/*` endpoints, which is what its `DashboardData` type already expects.

6. **Verify before deleting anything.**

   ```bash
   npm run typecheck --workspaces
   npx vitest run          # 241 must still pass
   npm run dev --workspace @agent/dashboard
   ```

## Deploying

Three services, one image. `Dockerfile` at the repo root builds all of it;
which process runs is the start command.

| Service | Start command | Notes |
|---|---|---|
| api | `node --import tsx api/src/index.ts` | Public. LinkedIn redirects here. |
| worker | `node --import tsx worker/src/index.ts` | No public port. |
| dashboard | `npm run build --workspace @agent/dashboard` | Static. Vercel or Cloudflare Pages. |

`railway.json` configures the api; `deploy/worker.railway.json` is the worker
service. Both build from the same Dockerfile so the two can never drift.

The build runs `vitest` and fails the image on a red suite. A broken build is a
better outcome than a broken release.

### Environment

Move every value out of `.env` into the platform's secret store. Three that
will bite:

- **`LINKEDIN_REDIRECT_URI`** must change from `localhost:8080` to the deployed
  API URL, **and** be updated on the LinkedIn app's Auth tab byte-for-byte.
  This is the step people miss.
- **`TOKEN_ENCRYPTION_KEY`** must match what is set on the database via
  `ALTER DATABASE ... SET app.token_encryption_key`. A mismatch decrypts every
  stored token to garbage.
- **`SUPABASE_SERVICE_ROLE_KEY`** goes to api and worker only. Never to the
  dashboard build; a `VITE_`-prefixed variable is compiled into the bundle.

### Before you let anyone else sign up

```
MULTI_TENANT=true
```

It defaults to `false` so single-tenant self-hosting keeps working. Left unset
on a shared deployment, the env fallback stays live and users without their own
keys run on the operator's LinkedIn app and Anthropic key.

### After the first deploy

`nohup` processes do not survive a reboot; that is what the platform replaces.
Confirm the worker is actually ticking (`{"job":"scheduler"...}` in its logs)
rather than assuming a green deploy means a running loop.
