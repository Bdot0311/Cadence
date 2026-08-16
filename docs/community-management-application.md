# Community Management API — application pack

Everything needed to apply, kept out of the v1 setup path because v1 does not
use it. Come back here when you want company pages, the engagement loop, or
real post analytics.

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

Two of these matter more than the rest: **webhooks** are what make the
engagement loop possible at all, and **analytics** are what give the learning
loop an automated input instead of manual entry.

## Before you apply

You need a working integration to demo. That is the point of shipping v1 first
— the personal-profile pipeline *is* the working integration, and the screencast
is much easier to record against something that already runs.

You also need:

- A LinkedIn company page you are a verified administrator of
- The app associated with that page on the app's Settings tab
- A privacy policy URL and a legal entity name on the app profile

## Justification text

Paste into the application, adjusting the specifics. Keep it concrete about what
the integration does and who uses it — vague applications get bounced.

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
> and weekly caps.

Adjust the second paragraph honestly. If you *do* intend to manage pages for
clients later, say so now — being approved for one thing and doing another is
worse than a longer review.

## The screencast

Reviewers want to see the integration working, not a slide deck. Record a single
unedited take showing:

1. **The app** — the LinkedIn developer app, its Products tab, and the
   associated company page.
2. **Authorization** — the full OAuth consent screen, including the scopes being
   granted. Do not cut away from the consent screen.
3. **Publishing** — trigger a post from your interface, then show it live on the
   page. The reviewer needs to connect the action to the result.
4. **Reading engagement** — a comment appearing in your interface after being
   left on the page.
5. **Replying** — a reply sent from your interface, then shown live on LinkedIn.
6. **Analytics** — the analytics view populated with real numbers from your page.

Keep it under five minutes. Narrate what you are doing. Show real data on a real
page, not fixtures — reviewers reject obviously mocked demos.

Because v1 has no engagement loop, steps 4 through 6 need to exist before you
can record. That is the ordering constraint: build the v2 code paths against
fixtures, record against a live page once approval-gated scopes are temporarily
available in dev, or record the publish path and be explicit that the rest is
pending. The first option is cleanest.

## After approval

1. Add `w_organization_social` and `r_organization_social` to `LINKEDIN_SCOPES`.
2. Re-run the OAuth flow. Existing tokens do not gain new scopes.
3. Run the v2 migration to add `engagement_events` and `comment_replies`.
4. Register the webhook callback URL on the app's Webhooks tab and subscribe the
   page to Organization Social Action Notifications. Handle the validation
   challenge on the callback.
5. Switch `performance` ingestion from `manual` to `api`. Existing manual rows
   stay distinguishable by the `source` column, so retire them deliberately
   rather than double-counting.
6. Update LIMITS.md. Move the deferred rows into the CAN table and delete the
   consequence notes. The WILL NOT list does not change.
