# Platform Architecture History, 2019–2026

A narrative history of the platform's major architectural eras, written so
new engineers understand *why* the system looks the way it does. Each era
covers what we built, what broke, and what we'd keep. This is the long
version; the two-page summary lives in the onboarding deck.

## The monolith era (2019–2021)

The original product was a single Rails application backed by one Postgres
instance, deployed twice a week by whoever held the deploy conch in chat.
Everything — checkout, catalog, scheduling, notifications, reporting —
lived in one repository with one test suite that took 70 minutes at its
worst. It is fashionable to dunk on this era, but the honest record is
that the monolith carried the company from zero to its first $10M of
revenue with a team of nine engineers, and the only two SEV-1s in that
window were both caused by the same third-party payment SDK.

What finally forced the split wasn't scale in the requests-per-second
sense; it was deploy coupling. The scheduling team's migrations kept
locking tables the checkout path needed, and a Tuesday deploy could not
ship a checkout fix without also shipping whatever half-done scheduling
work had merged since Friday. The decision memo from March 2021 framed it
explicitly: "we are splitting for independent deployability, not for
performance."

## Database sharding (2021–2022)

The orders table crossed 800M rows in late 2021 and vacuum times became a
standing agenda item. We sharded by customer_id across 16 logical shards
on 4 physical instances, with a routing layer (`shard-router`) that every
service was required to go through — direct database connections were
revoked at the network layer to make the router unavoidable.

The migration itself ran as a dual-write: every write went to both the old
unsharded layout and the new sharded layout, with an async comparator
flagging divergence. The plan budgeted three months of dual-writing; in
reality we kept writing to both layouts for 14 months, because every time
we scheduled the cutover, some team's batch job turned out to still read
the old layout directly. The lesson that stuck: a migration isn't done
when the new path works, it's done when the old path is *deleted*, and
nobody budgets for the deletion.

## The event bus and the death of Hermes (2022–2023)

Service-to-service communication in the early split era ran over a
homegrown message bus called Hermes — a thin layer over Redis streams that
one very smart engineer wrote in a weekend and that the company then bet
its nervous system on. Hermes was genuinely good for what it was, but it
had no consumer groups, no replay, and exactly one person who understood
its failure modes, and he left in May 2022.

After a six-week evaluation we replaced Hermes with Kafka, run by a
managed provider rather than self-hosted — the deciding factor was that
nobody wanted to own ZooKeeper on-call. The migration pattern was
strangler-fig: new event types went straight to Kafka, existing Hermes
topics were bridged by a relay service, and the last Hermes topic (cart
abandonment) was turned off in March 2023. The relay service, built as
throwaway code, ran for 11 months. Throwaway code with production traffic
is just production code with bad documentation.

## Multi-region (2023–2024)

European data-residency requirements, not latency, drove the multi-region
build-out. The EU region runs a full copy of the stack with its own
sharded database cluster; customer data never crosses regions, which made
the application changes mostly about *routing* rather than replication.
The genuinely hard part was the control plane: feature flags, config, and
deploy tooling all assumed one region, and each had to learn about region
affinity separately.

The cost surprise nobody modeled: cross-region observability. Shipping
logs and traces from the EU region to the US-based observability vendor
would have violated the residency commitments the region existed to
honor, so the EU region got its own observability stack, roughly doubling
that line item. Finance asks about it every quarter and the answer is the
same every quarter: it's the price of the compliance posture, not waste.

## The billing rewrite (2024–2025)

The original billing code calculated invoices imperatively, in place,
with no record of *why* an invoice came out the way it did. Support
couldn't explain charges; finance couldn't audit them without an engineer
reading code. The rewrite moved billing to an event-sourced ledger:
charges, credits, and adjustments are immutable events, invoices are a
deterministic fold over the event stream, and any invoice can be
re-derived and explained line by line.

The rewrite was rolled back twice before it landed. The first rollback
(August 2024) was a precision bug — the ledger rounded at intermediate
steps where the old code rounded once at the end, producing one-cent
differences on about 0.3% of invoices, which is roughly 0.3% more invoice
disputes than finance was willing to absorb. The second rollback (October
2024) was operational: replaying the full event history to materialize
balances took 9 hours, and the cutover runbook had budgeted 2. The third
attempt shipped in January 2025 behind a shadow mode that ran both
systems for a full quarter, comparing every invoice to the cent, and that
quarter of shadow data is what finally made finance comfortable signing
off.

## Search infrastructure (2025)

Product search moved off database LIKE queries (yes, really, that late)
onto a proper search engine with its own indexing pipeline. The
interesting decision was *not* adopting the search team's first proposal —
a real-time indexing architecture with sub-second freshness. Catalog
changes propagate on a 5-minute batch cycle instead, because when we
actually measured, merchant catalog edits arrived in bursts followed by
hours of silence, and the real-time pipeline's complexity bought freshness
nobody had asked for. The 5-minute batch architecture is one engineer's
part-time responsibility; the real-time design we didn't build was
estimated at a team of three.

## The data platform split (2025–2026)

Analytics queries against production replicas were the recurring villain
of every database incident review, so 2025's big investment separated the
analytical plane entirely: change-data-capture streams every production
table into an object-store lakehouse, and all reporting, dashboards, and
the ML feature pipelines read from the lakehouse with zero ability to
touch production. The CDC lag SLO is 15 minutes; the worst recorded lag —
during the January 2026 checkout incident, when the orders firehose
spiked — was 38 minutes, which the data team considers an acceptable
worst case and the ML team does not, a disagreement that resurfaces every
quarterly planning cycle.

## What we'd keep, what we'd skip

Keep: sharding by customer_id (every alternative we've seen at peer
companies aged worse), the managed-Kafka decision, shadow mode as the
standard for high-stakes cutovers, and the lakehouse split.

Skip: Hermes (build on boring infrastructure from day one), the 14-month
dual-write (set a deletion deadline with teeth), and probably one region's
worth of the multi-region control-plane rework, which a year of patience
and vendor maturity would have given us for free.
