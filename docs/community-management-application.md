# Community Management API — application pack

Everything needed to apply. Come back here when you want company pages, the
engagement loop, or real post analytics.

---

## Read this first: it needs its own app

**Community Management API must be the only product on its LinkedIn developer
app.** LinkedIn states this is "for legal and security reasons". If any other
product is provisioned or pending on an app, the *Request access* button for
Community Management is greyed out with:

> This product cannot be requested because there are currently other provisioned
> products or other pending product requests. A new developer application can be
> created to request this product.

So this is **not** a matter of adding scopes to the app you already have. Your
existing app holds *Share on LinkedIn* and *Sign In with LinkedIn*, which
permanently disqualifies it. You need a second app.

| | App 1 — Primary | App 2 — Community |
|---|---|---|
| Products | Share on LinkedIn, Sign In with LinkedIn (OIDC) | Community Management API, **alone** |
| Scopes | `openid profile email w_member_social` | `r_organization_social w_organization_social` |
| Powers | Personal-profile publishing | Company pages, comments, webhooks, analytics |
| Env vars | `LINKEDIN_CLIENT_ID` / `_SECRET` | `LINKEDIN_CMA_CLIENT_ID` / `_SECRET` |
| Status | Live | Pending approval |

App 1 keeps working exactly as it does now. Nothing about the personal-profile
agent changes.

### The consequence that bites

A refresh token can only be redeemed with the client credentials of the app that
**issued** it. Refreshing a Community token with App 1's `client_id` returns
`invalid_grant`, which reads like an expired token rather than a config error —
and the refresh job would retry it daily until the 365-day wall.

`accounts.linkedin_app` records the issuing app for exactly this reason
(migration `0005_two_apps.sql`). Do not remove it, and do not let a token from
one app be refreshed with the other's credentials.

---

## What approval unlocks

| Capability | Scope |
|---|---|
| Publish to company pages | `w_organization_social` |
| Read comments and reactions on posts you authored | `r_organization_social` |
| Reply to comments via socialActions | Comments API |
| Real-time engagement webhooks | Organization Social Action Notifications |
| Post, page, and follower analytics | CMA analytics endpoints |
| `@mention` followers in org posts | People Typeahead API |
| Discover the orgs you administer | Organization Access Control |

Two of these matter more than the rest. **Webhooks** are what make the
engagement loop possible at all, and **analytics** are what give the learning
loop an automated input instead of manual entry.

Note the console currently lists Community Management API at **Development
Tier**. Check its docs for volume limits before investing in the second app — if
the tier caps you somewhere that matters for your posting cadence, the trade
changes.

---

## Before you apply

**Create the second app.** <https://www.linkedin.com/developers/apps> → Create
app. Request *only* Community Management API on it. Requesting anything else,
even accidentally, disqualifies the app permanently and you start over with a
third one.

You also need:

- A LinkedIn company page you are a verified administrator of, associated with
  **app 2**
- A privacy policy URL and legal entity name on app 2's profile
- A working integration to demo (see the screencast section)

---

## Justification text

Paste into the application, adjusting specifics. Keep it concrete about what the
integration does and who uses it — vague applications get bounced.

> BDØT Industries LLC operates Outreign (outreign.io), a B2B cold email outbound
> platform. We are requesting Community Management API access to manage our own
> company page programmatically.
>
> Our use case is first-party page management for a single organization we own
> and administer. We publish original content to our company page on a scheduled
> cadence, monitor engagement on that content via Organization Social Action
> Notifications, and reply to comments left on our own posts. We also read post
> and follower analytics for our own page to inform our content strategy.
>
> We do not manage pages on behalf of third parties and are not building a
> resale or agency product. All content is authored by us for our own page.
> We do not read the member feed, search for members, or send connection
> requests, and our integration has no capability to do so.
>
> The integration is built entirely on documented REST endpoints with a pinned
> LinkedIn-Version header. It records rate-limit headers on every response,
> backs off on 429 and 503, and halts rather than retrying on authentication
> errors. Publishing is confined to configured time windows with enforced daily
> and weekly caps. Comment replies are rate-limited, restricted to our own
> posts, and never sent to hostile or spam comments.

Adjust the third paragraph honestly. If you *do* intend to manage pages for
clients later, say so now — being approved for one thing and doing another is
worse than a longer review.

---

## The screencast

Reviewers want to see the integration working, not a slide deck. Record a single
unedited take showing:

1. **The app** — app 2 in the developer console, its Products tab showing
   Community Management API as the only product, and the associated company page
2. **Authorization** — the full OAuth consent screen including the scopes being
   granted. Do not cut away from the consent screen.
3. **Publishing** — trigger a post from your interface, then show it live on the
   page. The reviewer needs to connect the action to the result.
4. **Reading engagement** — a comment appearing in your interface after being
   left on the page
5. **Replying** — a reply sent from your interface, then shown live on LinkedIn
6. **Analytics** — the analytics view populated with real numbers from your page

Keep it under five minutes. Narrate what you are doing. Show real data on a real
page, not fixtures — reviewers reject obviously mocked demos.

**The ordering problem.** Steps 3 through 6 need the scopes you are applying
for. There is no clean way around it. The realistic options, best first:

- Record steps 1 and 2 in full, and demonstrate 3 through 6 against the
  fixture-backed test suite, stating plainly that live calls are pending
  approval. The code paths exist and are visibly complete.
- Apply with a narrower initial demo and expand after a first grant.

The code is already written and gated, so if a reviewer grants provisional
access the demo becomes real without a build cycle.

---

## After approval

1. **Set app 2's credentials** in `.env`:
   `LINKEDIN_CMA_CLIENT_ID`, `LINKEDIN_CMA_CLIENT_SECRET`,
   `LINKEDIN_CMA_REDIRECT_URI`. Register that redirect on app 2's Auth tab,
   byte-for-byte.
2. **Do not touch `LINKEDIN_SCOPES`.** That is app 1's scope list and must keep
   holding only the member scopes. Org scopes live in `LINKEDIN_CMA_SCOPES`.
3. Apply migrations `0004_engagement.sql` and `0005_two_apps.sql`.
4. Run the **second** OAuth flow from the dashboard to connect the page. This
   creates a separate `accounts` row with `linkedin_app = 'community'`.
5. Set `ORG_FEATURES_ENABLED=true`.
6. Register the webhook callback URL on **app 2's** Webhooks tab and subscribe
   the page to Organization Social Action Notifications. Handle the validation
   challenge on the callback.
7. Switch `performance` ingestion from `manual` to `api`. Existing manual rows
   stay distinguishable by the `source` column, so retire them deliberately
   rather than double-counting.
8. Update `LIMITS.md`: move the deferred rows into the CAN table and delete the
   consequence notes. **The WILL NOT list does not change.**

### If the gate stays shut after all that

The most common cause is step 4. Adding a product in the console does not
upgrade an existing token — the account must be reconnected so OAuth re-runs
with the new scope. The client checks granted scopes and raises
`OrgFeaturesDisabledError` with that exact message rather than letting the call
403 and trip the anomaly halt.
