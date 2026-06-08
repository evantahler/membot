# Data Processing Agreement — Plain-language Summary

Internal summary of our standard DPA for sales and support staff. This is
not legal advice and never overrides the signed document; when a customer's
counsel asks something not covered here, loop in legal.

## Roles

The customer is the data controller; we are the data processor. We process
personal data only on documented instructions — in practice, the
instructions are "provide the service as configured by the customer."

## Subprocessors

We maintain a public subprocessor list; the current material ones are the
cloud infrastructure provider (US and EU regions), the email delivery
service, the payment processor, and the support-ticketing vendor.
Customers subscribe to change notifications and get 30 days' notice before
a new subprocessor touches their data, with a right to object. An objection
we can't resolve lets the customer terminate the affected service with a
prorated refund — this has been exercised once, ever.

## International transfers

EU/UK personal data is covered by the EU Standard Contractual Clauses
(module two, controller-to-processor) incorporated into the DPA, plus the
UK addendum. Customers on the EU data-residency add-on keep data at rest in
the EU region; support access from outside the EU is logged and
justification-tagged.

## Retention and deletion

Customer data is retained while the contract is active. After termination,
customers have 60 days to export. Personal data is deleted from production
systems within 30 days after that export window closes, and ages out of
encrypted backups within a further 90 days — so the worst-case full
deletion timeline is 180 days post-termination. Deletion certificates are
available on request for enterprise plans.

## Security commitments

The DPA incorporates the security exhibit: encryption in transit and at
rest, SOC 2 Type II audited annually, breach notification to the customer
without undue delay and within 72 hours of confirmation, and annual
penetration testing. We do not commit to customer-specific security
questionnaires inside the DPA itself — those run through the trust portal.
