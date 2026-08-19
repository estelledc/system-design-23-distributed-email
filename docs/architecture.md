# Architecture and failure boundaries

## Minimal slice

```text
synthetic caller
      |
      | POST /v1/messages + request key
      v
HTTP API/service -----------------------> PostgreSQL 17 authority
                                              | message + immutable content
                                              | recipient rows + receipts
                                              | assignments/leases/attempts
                                              | immutable status snapshots
                                              v
                                    bucket-specific worker process
                                              |
                                   prepare -> io_started (committed)
                                              |
                                              v
                              real loopback TCP SMTP-subset oracle
                              (fsynced acceptance digest before 250)
```

PostgreSQL and the SMTP oracle are deliberately different failure domains. The oracle's append-only digest ledger lets a test show
that a remote side accepted exactly once even when the worker dies before writing the local completion. It does not turn an SMTP
reply into mailbox or inbox proof.

## Submission path

1. HTTP validates authentication, exact JSON shape, synthetic addresses, content limits, and request identifiers.
2. The service canonicalizes the ordered intent and generated message, then computes SHA-256 digests.
3. One transaction serializes the request key, replays an identical receipt or rejects changed intent, inserts the message, inserts
   every recipient row, and stores the original result.
4. Only after commit may the API return `durableAccepted: true`. A crash after commit is recovered by exact request replay.

No separate broker is used. PostgreSQL rows are both queue and authority, removing an unproved database-to-broker dual-write from
the first slice.

## Worker path

1. An operator creates/takes over a destination-bucket assignment, producing a monotonically increasing generation.
2. The current worker claims one due recipient under a new lease generation using a short row-lock transaction.
3. It creates an `attempt` in `prepared` before TCP. A true-process crash here is safe to recover without an external-effect claim.
4. It commits `io_started`, releases every database lock, and only then opens TCP.
5. The SMTP client records numeric replies for greeting, EHLO, MAIL, RCPT, DATA initiation, and final DATA. Unsupported/malformed
   dialogue is typed; free-form reply text is neither a retry control nor an ordinary log field.
6. A completion transaction rechecks assignment, lease, attempt, and recipient revisions, then writes the terminal/retry result.

The worker performs one recipient transaction per TCP session. This sacrifices recipient batching to keep partial outcome and
response-loss reasoning executable.

## Recovery path

- expired `leased` work without an attempt returns to its prior due state;
- expired `attempting` work whose current attempt is only `prepared` returns to `retry_scheduled` without incrementing the attempt
  number again;
- expired `attempting` work with `io_started` becomes `unknown_after_io` and is held;
- a completion already committed before process death is replayed from recipient/attempt state;
- a stale assignment generation can observe neither a successful claim nor a successful completion.

`unknown_after_io` has no automatic edge in v0.1. A future reconciliation/retry-with-possible-duplicate operation would require a
new policy generation and explicit operator receipt.

## Status path

A live `GET /v1/messages/{id}` returns one current projection. `POST /v1/status-queries` instead reads the message, ordered
recipients, and ordered attempts in one transaction and stores a bounded JSON result. Page reads slice that immutable result, so a
retry between pages cannot mix revisions.

## Consistency and scaling boundary

- Atomic boundary: one PostgreSQL transaction, not a distributed transaction.
- Contention boundary: request key, message identity, recipient row, and bucket assignment.
- Time authority: PostgreSQL `statement_timestamp()` for due/lease/recovery decisions.
- Partition sketch: four fixed bucket labels derived from a destination-domain digest; no dynamic resharding.
- External boundary: loopback TCP only, no DNS/MX/TLS/public egress.
- Failure boundary: a local database commit and peer SMTP reply cannot be made atomic; uncertainty is a first-class state.

PostgreSQL HA, multi-region replication, a broker, connection pooling, destination scheduling, and real MTA interoperability remain
unproved extensions, not invisible features of this diagram.
