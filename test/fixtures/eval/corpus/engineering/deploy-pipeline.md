# Deploy Pipeline — shop-api and friends

How code gets from a merged PR to production for the core commerce services
(`shop-api`, `cart`, `inventory`). Frontend deploys are documented separately.

## Pipeline stages

1. **Build.** Merge to `main` triggers a container build; images are tagged
   with the git SHA and pushed to the internal registry. Builds are
   reproducible — same SHA, same digest.
2. **Staging soak.** The image deploys to staging automatically and soaks
   for 30 minutes under replayed production traffic (1% sample, PII
   scrubbed). Contract tests and smoke tests run during the soak.
3. **Canary.** Production rollout starts with a canary at 5% of traffic for
   20 minutes, automatically extended to 60 minutes if error budgets are
   tight that week. The canary analysis compares error rate, p95 latency,
   and CPU against the stable fleet with a 99% confidence gate.
4. **Full rollout.** Traffic shifts 5% → 25% → 50% → 100% in 10-minute
   steps. Any SLO breach pauses the shift and pages the deploy owner.

## Rolling back

Rollbacks are one command and do not rebuild anything:

```bash
# roll shop-api back to the previous release
helm rollback shop-api

# or pin a specific revision seen in `helm history shop-api`
helm rollback shop-api 47
```

A rollback redeploys the previous image digest and replays the previous
config. Database migrations are NOT rolled back automatically — see the
expand/contract policy below. Median time from "decision to roll back" to
"previous version serving 100%" is 4 minutes.

## Database migration policy

All schema changes follow expand/contract. The expand step (new columns,
new tables, dual writes) ships at least one release before any code depends
on it; the contract step (dropping old columns) ships at least one release
after the last reader is gone. This means any single release can be rolled
back without touching the schema.

## Deploy windows and freezes

Deploys are allowed 24/7 except during the change freeze around Black
Friday/Cyber Monday (the two weeks bracketing the holiday) and during
declared incidents. Freeze exceptions need VP sign-off and a rollback plan
pasted into the change ticket.

## Ownership

Whoever merges the PR owns the deploy: they watch the canary, they answer
the page if the rollout stalls, and they decide rollback versus fix-forward.
The deploy bot assigns them as `deploy-owner` in the release channel and
won't advance past canary without their ack during business hours.
