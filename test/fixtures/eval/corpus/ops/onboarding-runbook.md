# Engineering Onboarding Runbook

Checklist and context for a new engineer's first two weeks. Your onboarding
buddy walks this with you; nothing here requires heroics.

## Day 1: Accounts and hardware

- Laptop arrives pre-imaged; FileVault and the MDM profile are mandatory
  and pre-enabled. Do not remove the MDM profile — it gates VPN access.
- SSO account activates when HR marks you started. Everything (email, chat,
  GitHub, the cloud consoles) hangs off SSO; there are no per-app passwords.
- Enroll a passkey AND a hardware security key on day one. The hardware key
  is your recovery path; keep it off your keychain with the laptop.

## VPN and network access

We use WireGuard, managed through the `corpnet` app in Self Service. Click
"Enable corpnet," authenticate with SSO, done — keys rotate automatically
every 30 days. The VPN is split-tunnel: only `*.internal` routes through
it. If a service under `*.internal` hangs, check the corpnet menu-bar icon
first; an expired session looks exactly like a down service.

Production network access is separate from corpnet and requires the
infrastructure team to add you to a break-glass group — most engineers
never need it.

## Development environment

Clone the `dev-env` repo and run `./bootstrap.sh`. It installs toolchains,
container runtime, and seeds a local database with anonymized fixtures.
The script is idempotent; re-run it whenever something feels broken. A
clean bootstrap takes about 20 minutes; anything over 40 is a bug — file
it against `#dev-experience`.

## On-call and PagerDuty

You're added to PagerDuty in week 1 as an observer — you get a read-only
view of incidents but no pages. After your first production deploy
(typically week 3–4), your team lead schedules you as shadow on-call: you
receive every page your shadow partner gets, join the response, but carry
no resolution responsibility. Two shadow rotations later you enter the
primary rotation. Override your schedule for planned PTO in PagerDuty
directly; the bot syncs it to the team calendar.

## Week 2: First change

Ship something small but real in week 2 — a bug from the `good-first-issue`
label, a doc fix, a flaky test. The goal is exercising the full path:
branch, PR, review, canary, production, and watching your change on the
dashboards. Your buddy reviews the PR same-day.
