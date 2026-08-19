# ADR 0001: PostgreSQL authority with receipted per-recipient SMTP attempts

- Status: accepted for v0.1 design
- Date: 2026-08-19

## Context

The central unknown is not whether an architecture can name queues, SMTP workers, caches, and databases. It is whether submission,
fan-out, claim, attempt, retry, terminal state, and response-loss recovery remain explainable for every recipient when local commits
and external TCP effects cannot be atomic.

Adding a separate broker before this is executable would create a database/broker dual-write, another acknowledgement meaning, and
another recovery owner. Batching multiple recipients in one SMTP transaction would also make one final reply cover a partially
accepted envelope. Neither complexity is required to test the first invariant.

## Decision

Use one PostgreSQL 17 database as message, work-queue, lease, attempt, mutation-receipt, suppression, and status-snapshot authority.

- Submission inserts the immutable content once and every bounded recipient in one transaction.
- Request keys and message identities bind canonical intent digests and replay durable results.
- Four fixed destination buckets have monotonically increasing worker assignment generations.
- Each recipient claim has a lease generation/deadline; each attempt is prepared before I/O and then crosses a committed
  `io_started` boundary.
- No network wait occurs in a database transaction.
- One SMTP connection/transaction handles exactly one recipient.
- A final `2yz` is `remote_accepted`; `4yz` schedules a bounded retry; `5yz` is permanent for unchanged intent; pre-DATA network
  failure may retry; missing final reply after data or expired `io_started` work becomes `unknown_after_io`.
- v0.1 never automatically retries `unknown_after_io`.
- Immutable status queries store one bounded result rather than reconstructing pages from moving live rows.
- A separate loopback SMTP oracle fsyncs an acceptance digest before returning final `250`, enabling a real external-effect/local-
  commit-loss test without public network use.

## Alternatives rejected for this slice

- **Database plus broker/outbox:** valid when independent broker throughput/consumers are required, but adds a publish/checkpoint
  protocol before recipient correctness is proven.
- **In-memory queue:** cannot justify durable acceptance or process recovery.
- **One message-level job:** hides partial recipient rejection/retry and makes a single sent flag misleading.
- **Multi-recipient SMTP batching:** more efficient, but couples RCPT acceptance sets to one DATA/final-reply ambiguity.
- **Automatic retry after final-reply loss:** can duplicate remote mail; local idempotency cannot force an arbitrary peer to dedupe.
- **Distributed transaction with the peer:** SMTP exposes no shared atomic commit with this database.
- **Mock SMTP server:** cannot prove TCP framing, process separation, disconnect timing, or fsynced peer acceptance.

## Consequences

- PostgreSQL is one availability/scaling boundary; no broker or database failover is proven.
- Per-recipient sessions cost more connections and bytes than batching. The simplicity is intentional for v0.1.
- `io_started` is conservative: a crash immediately after it but before the first socket write can still become uncertain. The lab
  prefers abstention over a false safe-retry claim.
- The loopback oracle proves only its scripted subset and ledger. It is not an SMTP/ESMTP/MIME/DSN implementation or a mailbox.
- Any future broker, multi-region authority, batch SMTP, DNS/TLS, bounce reconciliation, or operator retry of uncertainty needs a new
  ADR, protocol receipts, and executable failure matrix.
