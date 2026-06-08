# Product Roadmap 2026

Theme for the year: win the mid-market field-services segment without
losing SMB velocity. Three bets, one per pair of quarters, plus a standing
quality budget of 20% of every team's capacity.

## Q1–Q2: Scheduling intelligence

Replace the rules-based dispatcher with the constraint solver piloted in
December. Customer-visible outcomes: suggested technician assignments with
explanations, automatic conflict resolution when jobs overrun, and a
"schedule health" score for dispatchers. The pilot showed a 14% reduction
in drive time across 40k jobs.

## Q2–Q3: Offline mode for field technicians

The single most-requested capability from mid-market prospects. Technicians
work in basements, parking garages, and rural areas; today the mobile app
hard-fails without connectivity, and field crews fall back to paper.

Scope for v1: job details, checklists, photo capture, signatures, and parts
consumption all work fully offline, syncing when connectivity returns.
Conflict policy is last-write-wins per field with a dispatcher-visible
conflict log — true merge UX is explicitly out of scope for v1. Payments
and new-customer creation remain online-only.

Engineering note: this is the riskiest item of the year — it forces the
mobile data layer onto a local-first sync engine. A two-week spike is
budgeted in late Q1 to choose between an off-the-shelf sync engine and an
in-house CRDT-lite approach.

## Q3–Q4: Customer portal

A white-labeled portal where end customers track appointments, approve
quotes, and pay invoices. Directly monetizable (portal seats are a paid
add-on in the new pricing) and shrinks the #2 support-ticket category,
"where is my technician?".

## Standing commitments

- Accessibility: WCAG 2.2 AA for all new surfaces, audited quarterly.
- Performance: mobile cold start under 2 seconds on the 2023 median device.
- Migration debt: the Angular admin pages must be fully retired by Q3.
