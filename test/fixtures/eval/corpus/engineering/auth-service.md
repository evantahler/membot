# Gatekeeper — Authentication Service Design

Gatekeeper is the company-wide authentication service. Every product surface
(web app, mobile apps, public API) delegates identity to Gatekeeper rather
than rolling its own login flows. This document describes the architecture,
the protocols we support, and the operational invariants.

## Goals and non-goals

Goals: single sign-on across all first-party products, support for enterprise
identity providers, phishing-resistant credentials for internal staff, and a
session model that survives mobile network flakiness.

Non-goals: Gatekeeper does not do authorization. Permission checks belong to
the products; Gatekeeper only answers "who is this?" with a signed identity
assertion.

## Protocol support

### OIDC for first-party apps

First-party web and mobile clients use OpenID Connect authorization code flow
with PKCE. The authorization endpoint lives at `auth.internal/authorize` and
issues one-time codes with a 60-second validity window. ID tokens are signed
with rotating ES256 keys published at the standard JWKS endpoint; clients must
tolerate a two-key overlap window during rotation.

### SAML for enterprise customers

Enterprise customers federate through SAML 2.0. We act as the service
provider; the customer's IdP (Okta, Entra, OneLogin in practice) is the
identity provider. Assertion consumer service URLs are tenant-scoped so a
misconfigured IdP can't replay assertions across tenants. We require signed
assertions and reject the `urn:oasis:names:tc:SAML:2.0:ac:classes:Password`
context for tenants that have enforced MFA.

## Session model

Browser sessions are cookie-based. The session cookie is named `gk_session`,
is HttpOnly + Secure + SameSite=Lax, and carries an opaque 128-bit identifier
— never a JWT. Session state lives server-side in a Redis cluster with a
write-through Postgres backup.

The session time-to-live is 12 hours of inactivity with a 30-day absolute
ceiling. Activity within a window slides the inactivity timer; nothing slides
the absolute ceiling. Mobile apps get a separate refresh-token grant with a
90-day rolling expiry because forcing a phone re-login every 12 hours tested
terribly.

### Refresh token rotation

Refresh tokens are single-use. Every refresh issues a new refresh token and
invalidates the old one; reuse of an already-spent refresh token is treated
as theft, revokes the entire token family, and forces interactive re-auth.
The token family tree is kept for 90 days for forensics. This is the part of
the system that pages on-call most often — clock-skewed clients double-spend
tokens — so the grace window for concurrent refresh is 10 seconds.

## Passkeys and WebAuthn

Internal staff accounts must enroll at least one passkey; passwords were
disabled for employees in January 2026. We use WebAuthn discoverable
credentials (resident keys) so the login page can offer a one-tap
"sign in with passkey" without asking for a username first. Attestation is
set to `none` — we don't verify authenticator make/model — but we do require
user verification (biometric or PIN), and we store the credential backup
state so security can audit which staff passkeys are synced to cloud
keychains versus hardware-bound.

Customer accounts may enroll passkeys optionally. Fallback remains
email-plus-password with TOTP. The long tail of customers on password
managers that mishandle WebAuthn kept us from forcing the issue this year.

## Operational invariants

- Auth latency p99 must stay under 120ms; the login path has a strict
  no-synchronous-third-party-calls rule.
- Key rotation is automated and runs every 30 days; an unrotated key older
  than 45 days fires a SEV-3.
- All identity assertions are logged to the audit pipeline with a 13-month
  retention, matching SOC 2 requirements.
