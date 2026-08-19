# Requirements and bounded acceptance contract

## v0.1 user-visible behavior

An authenticated synthetic caller can submit one message with one to eight unique `.invalid` envelope recipients. A successful
response means PostgreSQL committed the immutable message, the complete recipient fan-out, and the replay receipt atomically.
Exact retries return that result; changed intent conflicts.

A synthetic worker assigned to one of four destination buckets can claim one due recipient, prepare a durable attempt, mark the
network boundary, execute one real loopback TCP SMTP transaction, and record one of:

- `remote_accepted`: final DATA reply was `2yz`;
- `retry_scheduled`: a retryable pre-acceptance network result or `4yz`, within budget;
- `permanent_rejected`: `5yz` for the current unchanged intent;
- `suppressed`: current synthetic policy stopped I/O;
- `dead_lettered`: finite attempt/age budget ended;
- `unknown_after_io`: the process crossed the I/O boundary but no trustworthy local final classification was committed.

An authenticated consumer can fetch a live message projection or materialize an immutable, bounded status snapshot. Neither API
uses `delivered`, `inbox`, `read`, or `human accepted` as a synonym for the states above.

## Input contract

- JSON only; unknown fields, duplicate recipients, control characters, invalid Unicode/ASCII subset, bare carriage returns, and
  oversized values fail before durable acceptance.
- `messageId`: `msg_` plus 8–40 lowercase letters/digits.
- `requestKey` and query/worker IDs: typed prefix plus 8–40 lowercase letters/digits.
- envelope/header addresses: lowercase ASCII mailbox at a domain ending in `.invalid`, at most 254 characters.
- recipients: ordered list of 1–8; order is part of intent and assigns stable recipient ordinals.
- subject: printable ASCII, 0–120 bytes, no CR/LF.
- body: printable ASCII plus LF, normalized to CRLF, at most 4 KiB and 200 bytes per line.
- generated message: bounded From, To, Subject, Message-ID, Date-like synthetic sequence header, blank line, and body; no caller-
  supplied arbitrary headers, Bcc, MIME, attachments, 8-bit transport, or dot-framing control.

## State and ownership rules

```text
queued | retry_scheduled
  -> leased(worker assignment generation + recipient lease generation)
  -> attempting(prepared attempt -> io_started)
  -> remote_accepted | retry_scheduled | permanent_rejected
  -> unknown_after_io

queued | retry_scheduled -> suppressed
retry_scheduled -> dead_lettered
```

- One recipient has at most one active lease and one current attempt.
- A new worker assignment increments the bucket generation; an older generation cannot claim, cross the I/O boundary, complete,
  recover, or reschedule work.
- A prepared attempt exists before `io_started`. Expired prepared work is safe to requeue because the durable I/O boundary was not
  crossed. Expired `io_started` work becomes `unknown_after_io`; v0.1 never retries it automatically.
- Attempt number is capped at three. Backoff and max age are explicit configuration, with PostgreSQL time as authority.
- A final `2yz` means only remote-MTA responsibility. A missing final reply after message bytes were sent stays uncertain.

## Hypothetical sizing assumptions

The closed-book 10 million messages/day, 2.5 recipients/message, 12 KiB canonical content, 20× burst, 1% transient retry, and
0.01% response-loss scenario is not a workload forecast. It motivates:

- one immutable content copy per message rather than one copy per recipient;
- bounded recipient fan-out and message size at the API;
- per-destination bucket ownership and queue-age visibility;
- finite attempts and explicit ambiguity instead of infinite retries;
- one PostgreSQL transaction for acceptance/fan-out, but no external I/O inside it.

The executable fixture is far smaller and reports exact counts only.

## Availability, consistency, and overload

- PostgreSQL is the sole v0.1 authority. If it cannot commit, submission/claim/completion fail closed; the service does not enqueue
  in memory and call that durable.
- Read Committed live views may advance between requests. Immutable status snapshots are point-in-time materializations.
- Each request body, recipient set, lease, retry, snapshot, and result history is bounded. Over-limit submission is a typed `400`;
  authority unavailability is `503`; contention/version loss is a typed `409`.
- Four fixed synthetic destination buckets isolate claim capacity. This demonstrates bucket-local work selection, not Internet
  destination fairness, DNS routing, connection pooling, or reputation management.

## Completion criteria

v0.1 is complete only when pure tests, real PostgreSQL concurrency tests, a real loopback SMTP oracle, true-process `SIGKILL`
recovery, a fixed benchmark, privacy scans, dependency audit, and public Node 22/24/26 CI all pass without skipped infrastructure
tests. Passing them still proves no public email delivery, inbox placement, production capacity, SLA, or external acceptance.
