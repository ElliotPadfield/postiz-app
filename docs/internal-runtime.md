# Internal Postiz runtime

The calendar and publisher use PostgreSQL jobs. The default deployment is two containers: the Postiz application and PostgreSQL 17. A worker runs inside the backend process when `RUN_WORKER=true`; neither a Temporal server nor Redis is required. The upstream calendar, composer, media library, account connection flows and platform providers remain the starting point.

## Futurecraft and personal content

Use Postiz's existing channel groups for **Futurecraft** and **Personal** after connecting the real accounts. There is no seeded account or invented performance data.

For a Futurecraft video, select its channels in one composer session. Postiz's batch ID keeps those posts together in the editor, while each platform gets its own content, settings, publish time and job. One platform failing does not republish a successful platform.

For personal Instagram, TikTok, X and LinkedIn content, create separate posts or select only the channels appropriate to that piece. Separate composer sessions get separate batches. Nothing broadcasts every post to every connected profile. Organization ownership is checked on the post and channel, and edits cannot move a post into another organization.

## Scheduling and recovery

Post creation, calendar rescheduling, conversion to draft and deletion save their queue changes in the same Prisma transaction. Workers claim jobs with conditional updates and a version fence. An edit racing a claimed job is rejected before changing the post. Running or pending platform operations cannot be edited or deleted underneath the publisher.

The worker polls every two seconds. Publishing, analytics and token refresh have independent consumers so an analytics request cannot hold up scheduled publishing. Each kind has one active job per backend process. Run one application replica for this internal deployment; per-provider concurrency across multiple publishing replicas has not been benchmarked or enforced.

Pending upload state is saved privately in `PostExecution`, with durable polling times in the queue. A restart continues status checks without uploading again. A ready result is recorded before finalization, and the worker checks its lease immediately before every publishing mutation. Comments are queued after their parent is confirmed published, with their own delays and durable results.

Leases renew while requests run. Publishing operations have a thirty-minute deadline; analytics and refresh have a five-minute deadline. Late results are fenced from follow-up mutations or recording success after a lost lease. A dead worker cannot automatically repeat a possibly accepted post.

| Situation                                         | Result                                                       |
| ------------------------------------------------- | ------------------------------------------------------------ |
| Failure before the durable mutation marker        | Post becomes an editable error; correct it and reschedule    |
| Read-only pending-status request fails            | Retry with a bounded error budget                            |
| Publishing/finalization may already have happened | Preserve the attempt for review; do not automatically repost |
| Worker disappears during publishing               | Expired lease becomes review and appears as a calendar error |
| Completed platform result                         | Commit platform ID, URL and completed job together           |
| Notification or webhook delivery fails afterwards | Do not repeat publishing                                     |

Click an errored post's `!` badge to review its outcome. If the post is live, enter its platform ID and HTTPS link to record that fact. This does not send content or remaining comments. If a replacement is appropriate, create a separate post after checking the platform; an uncertain attempt is not silently reset. Review and confirmation are scoped to the current organization.

Token renewal is serialized per channel using an expiring Postgres lock, including concurrent analytics/publishing requests. Providers' propagation delays are preserved. Scheduled refreshes re-read the current credentials and expiry instead of retaining old tokens in jobs. OAuth state/PKCE, upload sessions/tickets, upload lists, caches and public API rate limits also use PostgreSQL, with real expiry and atomic consumption/conditional writes.

## Additional insights

Post statistics now includes a **Watch time and retention** panel with units, collection time and unavailable-data explanations. The existing basic statistics remain available for other platforms.

Instagram collects lifetime views, reach, likes, comments, shares and saves; Reel average watch time, total watch time and skip rate where available; and likes/shares/saves per 100 views. Common counts are fetched together and Reel-only metrics separately, with a fallback for unsupported metrics. An unsupported metric does not erase the others. Watch-time values are stored in milliseconds and displayed in seconds.

YouTube uses the authorized Analytics API for the selected period: views, engaged views, watch time, average view duration, average percentage viewed, likes, comments, shares and subscribers gained. It also requests audience-watch-ratio points and relative retention performance. Rewatch ratios above 100% are preserved, and relative performance is not presented as a viewer percentage. Likes per 100 views uses the same report window for both values. YouTube's Studio swipe-away percentage is not invented from engaged/public view counts.

Snapshots preserve collection time, report window, units, metric sources and nulls for unavailable values. Recent results are cached for ten minutes. Collection runs hourly for recent videos, every six hours after three days and daily after seven days, for up to the 1,000 most recent published roots. The richer collector only queues providers that implement this capability. Account permissions, media eligibility, API limits and reporting delays still determine which metrics are actually returned.

In Analytics, select a connected Instagram or YouTube channel and click **Import published posts** to add up to the 100 most recent owned posts. Instagram import stores numeric Graph media IDs. YouTube import checks canonical video status and only includes public, processed videos already published. Re-importing preserves existing/deleted records and does not create publishing jobs. Imports wait until unresolved publishing on that channel is reviewed or finished.

The authenticated import endpoint is `POST /analytics/import/:integration` with a JSON `limit` from 1 to 100. The authenticated internal read endpoints are `GET /analytics/post/:postId/insights?days=30` and `GET /analytics/post/:postId/insights/history`. They do not return channel credentials or private upload state. Live connection and analytics verification are deployment-specific; do not infer a connected account from a configured OAuth client alone.

Instagram retention screenshots remain separate source evidence: no verified full-curve endpoint is implemented. References: [Meta's generated insights metric names](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/insightsresult.py), [YouTube retention reports](https://developers.google.com/youtube/analytics/channel_reports#Audience_Retention), [YouTube metric definitions](https://developers.google.com/youtube/analytics/metrics).

## Deliberate limits

This internal runtime supports ordinary scheduled posts, supported provider comments/threads and pending-media processing. Repeating-post schedules, RSS autopost, automated plugs, managed media normalization, AI video generation and AI clipping are explicitly rejected rather than silently scheduled into a missing worker. Notification emails, when configured, send directly rather than through the old digest workflow. Publish webhooks retain their existing best-effort delivery behavior.

Historical Temporal workflows and their SDK dependencies remain in source for reference/upstream comparison. They are not started by the default dev, build or production scripts, and no Temporal connection module is imported by the backend. The old Redis implementation and direct Redis dependencies have been removed. Do not run the historical orchestrator alongside this worker or point both at the same post database.

## Run and validate

Use Node 22.23.4 and pnpm 10.6.1, as declared upstream. Local validation also ran on Node 24.20.0; the dedicated-server image pins Node 22.23.4.

```sh
pnpm install --frozen-lockfile
pnpm dev:docker
cp .env.example .env
# Set a unique JWT_SECRET, local URLs, and UPLOAD_DIRECTORY in .env.
pnpm prisma-db-push
pnpm dev
```

The development database binds only to `127.0.0.1:5439`. Keep `RUN_WORKER=false` when inspecting a database whose queued posts should not run. Use `RUN_WORKER=true` when you intentionally want approved scheduled content to publish.

For a dedicated server, set `PUBLIC_URL`, `POSTGRES_PASSWORD`, `JWT_SECRET` and the required provider OAuth credentials in the private `.env`, then build with `docker compose build` and start with `docker compose up -d`. The application binds to loopback port 5000 for the server's HTTPS reverse proxy. OAuth callbacks and platform-accessible media URLs need that public HTTPS address. Persist and back up both the PostgreSQL and uploads volumes. The dedicated-server image has been built and deployed successfully on Coolify. Check the deployment record and connected-account list for the current runtime and authorization status.

For Coolify, select `docker-compose.coolify.yaml` and route the `app` service to port 5000. Set `PUBLIC_URL` and `BOOTSTRAP_OWNER_EMAIL`; Coolify generates the database password, JWT secret and owner password using its `SERVICE_*` variables. Keep these credentials and provider secrets runtime-only. Startup initializes the first owner before the HTTP processes start, then leaves existing credentials untouched on later launches. The owner has organization administration rights, not global application administrator access. The Compose file publishes no host port and owns separate PostgreSQL/uploads volumes. Use the owner's generated password to log in; do not expose it in deployment logs or source control.

Validation commands:

```sh
pnpm build:backend
pnpm build:frontend
POSTIZ_TEST_BOOT=true pnpm test:internal-jobs
```

The test runner creates a disposable PostgreSQL instance on a random loopback port, generates the pinned Prisma client, pushes the schema, runs real-database tests with mocked platform APIs, boots the compiled backend with its worker enabled against those fixtures, checks health/authentication, then removes the database container. It overrides inherited database URLs and refuses arbitrary databases. No social publishing or paid AI API is exercised. `git diff --check` and formatting are also checked. ESLint remains blocked while loading the unchanged upstream Next/FlatCompat configuration (`Converting circular structure to JSON`).

Validated on 1–2 November 2026: 44 tests pass; backend and frontend production builds pass; the backend boots against Postgres alone with its worker enabled; authenticated access, query validation and cross-organization isolation pass. Independent review found no remaining P1/P2 blocker after fixes. These are local and mocked-provider results, not proof of a live platform connection or a deployed server.

Public static app information is available at `/about.html`, `/privacy.html` and `/terms.html` for provider OAuth branding. These pages contain no workspace records and do not grant access to the app.

Personal LinkedIn uses the self-service OpenID profile and member-posting permissions. Company Page authorization remains separate. Personal company-tag lookup requires additional approved organization permissions; it is not enabled by the basic self-service grant.

YouTube OAuth requests only YouTube and YouTube Analytics scopes, and reads the authorized native channel identity through `channels.list(mine=true)`. Google profile/email scopes are not needed for this connection.
