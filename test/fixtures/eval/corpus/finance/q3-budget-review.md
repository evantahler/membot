# Q3 Budget Review — Infrastructure and Tooling

Quarterly review of engineering spend against plan. Q3 came in 8.2% over
budget; this document explains where and what we're changing.

## Cloud spend

Plan was $342k for the quarter; actuals landed at $379k. Three drivers:

1. **The staging traffic-replay system** (new this quarter) runs a second
   copy of the commerce fleet for 30 minutes per deploy. Worth it, but it
   was never added to the budget model — $14k/quarter.
2. **Egress from the analytics export feature.** Two large customers turned
   on hourly raw-event exports to their own warehouses; egress charges grew
   $9k over the quarter. Pricing doesn't currently recover this; finance is
   adding an egress pass-through clause to the enterprise order form.
3. **GPU inference nodes for the search feature** beta — $11k, planned for
   Q4 but pulled forward. Timing variance, not overrun.

Reserved-instance coverage sits at 71% of steady-state compute; pushing to
80% would save roughly $6k/month and is approved for early Q4.

## Vendor and tooling

The observability bill crossed $30k/quarter and is now the second-largest
line after cloud. Log volume, not host count, drives it — debug logging
shipped to production in two services in August added 40% volume in a
month. A log-sampling policy ships in October with a target of cutting
indexed volume by half. Renewal negotiation starts in November with a
volume-commit discount on the table.

CI minutes came in under budget for the first time since 2024 — the
test-sharding work paid for itself in one quarter.

## Headcount-adjacent

Contractor spend for the accessibility audit ($28k) was planned. The
unplanned item is a second penetration test ($19k) required by a large
prospect's security review; sales has been told future commitments of
customer-driven security work need finance sign-off before the contract is
verbal.

## Actions

- Add staging traffic-replay to the budget model. (Owner: platform lead)
- Egress pass-through clause in enterprise contracts. (Owner: finance)
- RI coverage to 80% in October. (Owner: infra)
- Log sampling policy, 50% indexed-volume target. (Owner: observability)
