# Pricing Experiments — H2 2025 results

Summary of the three pricing experiments run between July and December 2025,
with decisions. Raw dashboards live in the analytics workspace; this is the
narrative record.

## Experiment 1: Annual-only enterprise tier

Hypothesis: removing the monthly option from the Enterprise tier increases
annual contract value without hurting win rate. Split: 50/50 on inbound
enterprise leads for 90 days.

Result: win rate dropped 9% (outside our 5% guardrail) and sales cycle
lengthened 11 days. ACV did rise 18%, but the win-rate hit makes it net
negative. **Decision: not shipped.** Monthly Enterprise stays, with annual
positioned as default in sales conversations.

## Experiment 2: The decoy tier

Hypothesis (classic decoy effect): inserting a deliberately unattractive
middle option shifts buyers from Starter to Professional. We added a
"Standard" tier at $39/seat that was Professional minus automations and
minus phone support — priced only $10 below Professional.

Result: the share of new signups choosing Professional rose from 31% to
47%; Starter share fell 13 points; the decoy itself was chosen by under 2%
of buyers, exactly as intended. Blended ARPU rose 12.4% with no measurable
churn difference at 90 days. **Decision: shipped to 100% in November.**
The Standard tier remains on the pricing page purely as an anchor.

## Experiment 3: Usage-based add-on for API calls

Hypothesis: metering API calls above a generous included quota converts
heavy integrators into a new revenue line without scaring smaller shops.

Result: inconclusive. Only 4% of accounts exceeded the included quota
during the test window, and the affected accounts' usage was so spiky that
invoice amounts swung 6x month-to-month, generating support escalations
about "surprise bills." **Decision: paused.** Revisit with committed-use
bands (pay for a tier of calls, not per call) instead of pure metering.

## Meta-learnings

- Guardrail metrics (win rate, churn) saved us once this half; every pricing
  test needs them pre-registered.
- The decoy worked because the gap to Professional was small and legible.
  An earlier informal attempt with a $25 gap did nothing.
- Pricing-page experiments need 90 days minimum — buying committees are slow
  and 30-day reads reversed twice.
