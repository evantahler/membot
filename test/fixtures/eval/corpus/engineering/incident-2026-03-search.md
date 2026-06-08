# Postmortem: Search results outage, 2026-03-08

Severity: SEV-2. Duration: 14:10–15:55 UTC. Customer impact: product search
returned empty results for roughly 30% of queries; browsing and checkout
were unaffected.

## Summary

A deploy of the search-indexer shipped a tokenizer configuration change
that was incompatible with the documents already in the index. Queries
tokenized under the new analyzer stopped matching documents tokenized under
the old one. The canary did not catch it because canary analysis compares
error rates and latency — and an empty result set is a successful, fast
response.

## Timeline

- 14:02 — search-indexer deploy reaches 100% (canary passed cleanly).
- 14:10 — Support flags a spike in "search shows nothing" tickets.
- 14:24 — Zero-results-rate dashboard confirms: 31% of queries, up from 6%.
- 14:31 — SEV-2 declared. Deploy diff points at the analyzer config.
- 14:40 — `helm rollback search-indexer` returns query-side behavior to the
  old analyzer; zero-results-rate halves but does not recover fully.
- 15:10 — Documents indexed during the bad window (about 2 hours of
  catalog updates) are identified as poisoned and queued for reindex.
- 15:55 — Backfill reindex completes; zero-results-rate at baseline.

## Root cause

The analyzer change (switching the stemmer and adding a synonym filter)
changed how terms are written to the inverted index. Index-time and
query-time analysis must agree; deploying the change to live traffic
without a full reindex guaranteed disagreement. This is a well-known
search-engine failure mode that our deploy tooling has no concept of.

## Remediation items

1. **Zero-results-rate added to canary analysis** for every service tagged
   `search-path`. An empty answer is now a signal, not a success. (Done.)
2. **Analyzer configs are versioned with the index.** The indexer refuses
   to serve queries when the query-time analyzer version doesn't match the
   index's recorded version — failing loudly beats matching nothing. (Done.)
3. **Reindex automation.** A full reindex is now a one-button job with
   progress reporting, rather than a hand-run script. The 45-minute manual
   gap between rollback and backfill was the bulk of the customer impact.
   (In progress.)

## Lessons

Canaries only catch what they measure. Quality-of-results regressions need
domain metrics (zero-results rate, click-through on first page) in the
gate, not just the four golden signals.
