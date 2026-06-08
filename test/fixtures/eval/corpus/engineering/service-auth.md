# Service-to-Service Authentication

How internal services authenticate to each other. This is a separate
problem from user authentication (see the Gatekeeper design doc) — no
humans, no sessions, no cookies; just workloads proving identity to other
workloads.

## Identity model

Every workload gets a SPIFFE identity (`spiffe://internal/ns/<namespace>/
sa/<service-account>`) issued by the mesh's workload attestor. Identity is
bound to the deployment, not to a deployable artifact or a network
location — two replicas of the same service share an identity; a service
impersonating another's IP gets nothing.

## Transport: mutual TLS

All service-to-service traffic inside the mesh runs over mutual TLS. The
sidecar handles the handshake; application code never touches certificates.
Workload certificates are short-lived — 4-hour expiry, rotated at half-life
by the sidecar with no restart — so certificate revocation is effectively
"wait two hours" plus an explicit deny-list entry for emergencies.

The root CA for the mesh is offline; an intermediate signs workload certs
and itself rotates every 90 days. Rotation of the intermediate is the only
scheduled event with a runbook — it has paged twice, both times because a
service pinned the intermediate instead of the root.

## Authorization

mTLS proves *who is calling*; per-route authorization policies decide
*whether the call is allowed*. Policies are declared in the service's repo
(`authz.yaml`), reviewed like code, and compiled into the mesh config.
Default is deny: a new service can't call anything until it declares the
edge, and the target team approves the PR. Wildcard grants
(`from: anything`) require a security-team stamp and an expiry date.

## External and legacy callers

Batch jobs and legacy VMs outside the mesh authenticate with short-lived
JWTs from the workload token service, exchanged for mesh access at the
gateway. Static API keys for internal calls were eliminated in 2025; the
last two holdouts (the data-warehouse loader and the old cron box) were
migrated in Q4. There is no break-glass static credential — break-glass is
a security-team-issued 24-hour identity with full audit.

## Debugging tips

`meshctl whoami` from inside a pod shows the workload's current identity
and cert expiry. The most common failure is a stale deny-list entry from
an old incident: check `meshctl policy explain <src> <dst>` before blaming
certificate rotation.
