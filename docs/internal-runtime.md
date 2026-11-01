# Internal Postiz runtime

This fork reuses Postiz's interface and platform providers. It is intended to become an internal planner, publisher and analytics workspace running on one dedicated server, with PostgreSQL holding both application data and durable jobs. The worker can be a second process in the same application image; it does not need another server.

## Current implementation

The first change adds an opt-in Nest module at `libraries/nestjs-libraries/src/database/prisma/internal-jobs/`. It provides delayed jobs, rescheduling, cancellation, atomic worker claiming, renewable leases and restart recovery using the existing Prisma dependency. It adds one table and two enums. No existing persisted field changes meaning, and the existing Temporal workflows remain untouched.

**This is a queue foundation, not a completed replacement scheduler.** The module is not imported by the backend, no polling process starts automatically, and no platform publishing or analytics calls are connected to it. The existing calendar still uses Temporal and Redis. There is no new external API or MCP surface.

Jobs contain an organization ID, target reference, kind and execution metadata. Tokens, post content, media and provider responses do not belong in the queue. The later publisher will resolve the current target and credentials through the existing services when it runs. These references currently have no foreign keys: the integrating service must validate organization ownership, target existence and approval before enqueueing, and revalidate before calling a provider. This generic service must not be exposed directly as an API.

The application uses Prisma conditional updates to claim a job only if its version and queued state still match. This is appropriate for a small internal queue and avoids adding another package or raw SQL. Contention is bounded: a worker yields after ten failed claims and tries on its next poll. No throughput benchmark has been run.

The job service deliberately has different recovery rules:

| Event | Publish job | Analytics read |
|---|---|---|
| Worker claims the job | Becomes running, gets a unique lease token | Same |
| Handler succeeds within its live lease | Can complete | Can complete |
| Handler reports an error | Requires review | Retries with backoff, up to five attempts |
| Worker disappears or lease expires | Requires review | Requeues, or fails after five attempts |
| Old worker returns after recovery | Its token cannot complete or renew the job | Same |
| Already completed target is scheduled again | Rejected | Allowed for another snapshot |

An expired publish may already be live on the platform. Queue claiming does not provide exactly-once external delivery. A job in review cannot be automatically scheduled again; a later reconciliation flow must determine the actual platform outcome. No such reconciliation flow is implemented yet. A running publish cannot be cancelled or edited by this queue, because cancellation cannot undo a request already sent.

## Validate locally

Use Docker, Node 22.23.4 (upstream's declared version) and pnpm 10.6.1. Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test:internal-jobs
```

The test runner starts its own PostgreSQL 17 container with a random loopback-only port and temporary storage. It generates the pinned Prisma 6.5 client, pushes the schema to that disposable database, runs integration tests and removes its container/network afterwards. It overrides inherited database URLs; the tests also refuse non-loopback or differently named databases. It never connects to a social platform. If the process is killed before cleanup, remove the `postiz-queue-test-<process-id>` Compose project explicitly.

The suite checks delayed execution, sixteen workers competing for one publish, rescheduling, tenant-scoped cancellation, running-job conflicts, uncertain publish outcomes, expired leases, renewal, completed-publish deduplication, read retries, stale workers and persistence across a service restart. These checks validate queue behavior; they do not validate a complete Postiz deployment.

The root install hook now runs the Prisma CLI already pinned in this repository instead of downloading a second copy with `pnpm dlx`. This avoids the separate download/build-approval failure observed during initial setup.

Validation on 1 November 2026 used Node 24.20.0 and pnpm 10.6.1; Node 24 differs from upstream's declared Node 22.23.4. All 14 real-Postgres integration tests passed, as did `pnpm build:backend`, Prisma schema validation, formatting and `git diff --check`. The repository's ESLint command failed while loading its unchanged Next/FlatCompat configuration (`Converting circular structure to JSON`), before linting the files. No frontend build or full application boot was performed.

## Integration work remaining

1. Introduce a scheduler service at the existing post lifecycle boundary. Save the post change and job intent in one database transaction, cover create/edit/draft/delete races, and make failures visible to the calendar. Do not run the old and new schedulers for the same post.
2. Build a worker around the existing generic provider interface. Renew leases, validate approval and the current post before a mutation, preserve pending upload state, poll processing status and reconcile uncertain results. Record platform IDs durably before follow-up steps. Cover multi-part posts, delayed comments and repeat schedules before enabling those controls.
3. Replace Temporal startup hooks, token refresh and the selected notification/background tasks. Features that have not been ported must be disabled visibly rather than silently dropped. Keep upstream workflows versioned and unchanged.
4. Replace Redis's OAuth state/PKCE storage, upload tickets, caches, locks and throttling with implementations that preserve atomicity and expiry. The in-memory Redis mock is not the server runtime.
5. Add durable per-post metric snapshots through the provider interface, starting with Instagram and YouTube. Store metric definitions, collection times and unavailable values explicitly. Import retention screenshots separately where the API does not expose the graph. Map existing published videos without creating new platform posts.
6. Connect scripts, media and animation annotations to those posts for retention analysis. Distinguish observed cuts/motion from model interpretation, and compare videos at similar ages and lengths.
7. Boot the application without Temporal/Redis, verify the real calendar and account connection flows, and package the dedicated-server deployment. Publishing against an account requires the user's approval for the actual post.

No server has been deployed, no social account has been connected by this change, and no post has been published.
