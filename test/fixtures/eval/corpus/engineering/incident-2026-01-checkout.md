# Postmortem: Checkout latency incident, 2026-01-14

Severity: SEV-1. Duration: 06:42–09:15 UTC. Customer impact: checkout
completion rate dropped from 94% to 61%; an estimated $410k of orders were
abandoned or retried. No data loss.

## Summary

A routine schema migration on the orders database held locks far longer than
staging tests predicted. Application servers piled up waiting on the
database, exhausted their connection pools, and began failing health checks.
The cascading restarts amplified load until the migration was killed.

## Timeline

- 06:31 — `orders-db` migration 0492 (add column + backfill) starts.
- 06:42 — p99 latency on `POST /checkout` crosses 4s; first alerts fire.
- 06:51 — On-call confirms connection pool saturation on checkout fleet.
- 07:05 — Incident declared SEV-1; migration identified as suspect.
- 07:38 — Migration killed; locks released. Latency does not recover.
- 07:52 — Discovery: app servers stuck in restart loop, each restart
  re-opening hundreds of connections and re-saturating the database.
- 08:20 — Fleet restarts staggered with a 30-second jitter; recovery begins.
- 09:15 — Checkout completion back at baseline; incident closed.

## Root cause

The backfill in migration 0492 updated rows in 50,000-row batches without
yielding, taking an ACCESS EXCLUSIVE lock burst at each batch boundary.
Staging has 2% of production's row count, so the lock windows were invisible
in testing. Each lock burst stalled every checkout transaction for 3–8
seconds; the application's connection pool (capped at 40 per instance) filled
with stalled transactions, and new requests queued until the load balancer
marked instances unhealthy.

The restart loop was self-inflicted: our health check counts a saturated
pool as "unhealthy," so the orchestrator kept killing exactly the instances
that held queue position, multiplying reconnect storms.

## What went well

Alerting fired within 11 minutes of first customer impact. The incident
channel stayed disciplined. Rollback of the migration itself was clean.

## Remediation items

1. **Connection pooling moved to PgBouncer.** The checkout fleet now
   connects through PgBouncer running in `pool_mode=transaction`, which
   multiplexes the 40-per-instance application pools down to 120 actual
   server connections. Stalled transactions no longer starve new arrivals
   of a slot. (Done, 2026-01-21.)
2. **Migration linter.** CI now rejects backfills that don't use
   keyset-paginated batches with `lock_timeout` set; migration 0492's
   pattern is specifically banned. (Done, 2026-01-28.)
3. **Health check distinguishes saturation from failure.** A saturated-but-
   progressing pool now reports degraded, not dead, so the orchestrator
   stops restart-looping instances under load. (In progress.)
4. **Staging data scale.** Quarterly job to clone a masked 25% sample of
   production row counts into staging so lock behavior is representative.
   (Scheduled for Q2.)

## Lessons

The database was never the bottleneck — the pool architecture was. A
transaction-mode pooler in front of Postgres would have turned a 2.5-hour
SEV-1 into a 10-minute blip. We also re-learned that health checks which
can't distinguish "busy" from "broken" convert load problems into
availability problems.
