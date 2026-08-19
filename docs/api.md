# HTTP and worker contracts

All HTTP requests use `Authorization: Bearer <synthetic token>` and JSON. Responses include `requestId`, but ordinary logs contain
neither that ID nor message/address/content data. Exact shapes are closed: unknown fields are rejected.

## Submit a message

`POST /v1/messages`

```json
{
  "requestKey": "req_submit0001",
  "messageId": "msg_example0001",
  "envelopeFrom": "sender@origin.invalid",
  "headerFrom": "author@origin.invalid",
  "headerTo": ["reader@alpha.invalid"],
  "recipients": ["reader@alpha.invalid", "archive@beta.invalid"],
  "subject": "synthetic receipt",
  "body": "bounded synthetic body"
}
```

`201` for first commit, `200` for exact replay:

```json
{
  "messageId": "msg_example0001",
  "revision": 1,
  "recipientCount": 2,
  "durableAccepted": true,
  "remoteAcceptedRecipients": 0,
  "mailboxDeliveredRecipients": 0,
  "inboxPlacedRecipients": 0,
  "readRecipients": 0,
  "externalAcceptanceProved": false
}
```

The same principal/request key or message ID with changed canonical intent returns `409 intent_conflict`.

## Live and immutable status

- `GET /v1/messages/{messageId}`: current aggregate plus ordered recipient states; no content/address echo.
- `POST /v1/status-queries`: `{ "queryId", "messageId" }`; materializes one immutable snapshot or replays it.
- `GET /v1/status-queries/{queryId}?offset=0&limit=2`: pages only the stored snapshot and returns a next offset.
- `GET /v1/mutation-receipts/{requestKey}`: recovers the caller's original result within the retention horizon.

Recipient entries expose ordinal, address digest, bucket, state, revision, attempt count, next due time, and numeric/stage evidence.
They never expose the address, header, subject, body, SMTP free-form reply, or auth value.

## Worker/operator operations

- `POST /v1/worker-assignments`: creates or takes over a fixed bucket and returns its generation.
- `POST /v1/recipient-claims`: current worker/generation claims at most one due recipient for a bounded lease.
- `POST /v1/attempts`: creates or reuses the current prepared attempt before I/O.
- `POST /v1/attempts/{attemptId}/io-started`: commits the conservative network-effect boundary.
- `POST /v1/attempts/{attemptId}/complete`: stores numeric stage evidence and classifies the recipient.
- `POST /v1/recoveries`: current worker recovers expired work in its bucket.
- `POST /v1/suppressions`: versioned synthetic address-digest policy used before any attempt.
- `GET /v1/state`: low-cardinality counts, oldest due age, active leases, ambiguity, and invariant gap.

The executable worker invokes the same service/repository contracts directly so a real worker process can be killed at exact commit
boundaries without adding a second untested HTTP orchestration layer.

## Error vocabulary

| HTTP | Code | Meaning |
|---:|---|---|
| 400 | `invalid_input` | closed schema, identifier, address, header, body, pagination, or limit failure |
| 401 | `unauthorized` | missing/wrong bearer value |
| 404 | `not_found` | no visible message/query/receipt/attempt |
| 409 | `intent_conflict` | stable key or entity reused with changed intent |
| 409 | `stale_generation` | assignment/lease/recipient revision no longer current |
| 409 | `invalid_transition` | requested state edge is not allowed |
| 429 | `overloaded` | configured in-process request/worker admission bound reached |
| 503 | `authority_unavailable` | PostgreSQL unavailable or transaction could not complete |

SMTP numeric replies are domain evidence inside successful worker operations, not HTTP error codes.
