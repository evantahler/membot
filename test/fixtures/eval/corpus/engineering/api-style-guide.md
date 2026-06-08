# Public API Style Guide

Conventions for the public REST API (`api.example.com/v2`). Internal
service-to-service APIs may deviate; the public surface may not.

## Resource naming

Plural nouns, kebab-case path segments, no verbs in paths. Actions that
don't map to CRUD become sub-resources (`POST /orders/{id}/cancellations`),
never RPC-style paths (`POST /cancelOrder`).

## Error envelope

Every non-2xx response carries the same JSON envelope:

```json
{
  "error": {
    "type": "invalid_request",
    "code": "missing_field",
    "message": "body.email is required",
    "doc_url": "https://docs.example.com/errors#missing_field",
    "request_id": "req_8fK2nA"
  }
}
```

`type` is a closed enum (invalid_request, authentication, permission,
not_found, conflict, rate_limited, server_error). `code` is open-ended and
stable — clients may branch on it. `message` is for humans and may change
without notice. Never put PII in `message`.

## Pagination

List endpoints use opaque cursor pagination. Responses include
`next_cursor`; clients pass it back as `?cursor=`. Cursors are base64url
of an internal keyset position and are valid for 24 hours:

```bash
# first page
curl -s "https://api.example.com/v2/orders?limit=100"

# subsequent pages — treat the cursor as opaque, do not parse it
curl -s "https://api.example.com/v2/orders?limit=100&cursor=eyJrIjoiMjAyNi0w..."
```

Offset pagination is banned on the public surface: it skips or duplicates
rows under concurrent writes, and deep offsets are O(n) in Postgres.

## Versioning and deprecation

The major version lives in the path (`/v2/`). Breaking changes require a new
major version; we commit to 18 months of overlap support. Deprecations are
announced via the `Sunset` header and a changelog entry at least 6 months
before removal. Adding fields to responses is never considered breaking —
clients must ignore unknown fields.

## Rate limiting

Limits are per API key: 1,000 requests/minute sustained with burst to
2,000. Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset`. A 429 includes `Retry-After`. SDKs must implement
exponential backoff with jitter; hand-rolled tight retry loops are the #1
cause of key suspensions.

## Idempotency

All POST endpoints accept an `Idempotency-Key` header. Keys are scoped per
API key, stored for 24 hours, and replay the original response (including
errors). Payment-adjacent endpoints reject requests without the header.
