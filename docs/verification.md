# Verification ledger

## Evidence levels

| Claim | Required evidence | Current state |
|---|---|---|
| closed-book invariants predate source reading | first Git commit | passed: `9458ff9b08bea598fcc77d1390ddf9f1638b00e8` |
| fixed chapter and primary pages were acquired completely | fixed identities, SHA-256, valid receipts | passed; see research log |
| validation/digest/state-machine logic | deterministic unit/property tests | pending implementation |
| atomic fan-out, claim, retry, fencing, snapshots | real PostgreSQL 17 integration tests | pending implementation |
| SMTP stage and disconnect behavior | real loopback TCP oracle | pending implementation |
| response-loss recovery | real API/worker `SIGKILL` processes plus database/oracle readback | pending implementation |
| bounded performance observation | fixed fixture/runtime/service versions and raw JSON | pending implementation |
| reproducible remote default branch | public commit plus green Node 22/24/26 CI | pending publication |

## Planned pure-test matrix

- exact input schema, `.invalid` address grammar, identifier/body/header/line/recipient limits, CRLF/dot handling;
- canonical intent/content/address digests, ordered recipient semantics, changed-intent conflict;
- recipient transition graph, attempt-number/retry-age bounds, deterministic backoff, SMTP stage/code classification;
- message projection for all-queued, all-remote-accepted, mixed, uncertain, and terminal recipient sets;
- HTTP authentication, errors, body limits, route shutdown, and log redaction.

## Planned PostgreSQL/TCP matrix

- one transaction creates message, complete ordered fan-out, and mutation receipt; forced failure leaves none;
- concurrent exact submission returns one revision/result; changed body or recipient order conflicts;
- competing claims yield one owner; takeover fences old claim/start/complete/recovery;
- attempt exists before I/O; prepared-only expiry safely reschedules; `io_started` expiry becomes uncertain;
- real loopback dialogues cover final `250`, final `451`, final `550`, connect failure, and disconnect after DATA;
- suppression wins before TCP; mixed recipients retain independent states;
- transient completion schedules once and ends at bounded dead letter; permanent reply never schedules automatically;
- immutable status page remains unchanged while live recipient state advances;
- state health reports zero invariant gaps and no sensitive values.

Infrastructure tests must fail when `DATABASE_URL` or the loopback oracle is unavailable; they never skip and call that green.

## Planned true-process crash smoke

1. API commits submission then receives `SIGKILL` before response; restart/exact replay returns revision 1.
2. Worker commits a prepared attempt then receives `SIGKILL` before I/O; oracle connection count stays zero and recovery safely
   reschedules the same recipient.
3. Worker receives oracle final `250`; oracle fsyncs one acceptance, then worker receives `SIGKILL` before local completion. Recovery
   records `unknown_after_io`, local `remote_accepted` stays false, and no automatic duplicate is sent.
4. Worker commits a `451` retry schedule then receives `SIGKILL`; restart observes exactly one completed attempt and one schedule.
5. A stale worker generation is rejected before opening TCP after a takeover.

The smoke receipt will report killed process count, messages/recipients/attempts, oracle connections/acceptances, retries,
uncertainties, remote-MTA acceptance, and explicit false mailbox/inbox/read/external-acceptance fields.

## Benchmark boundary

The fixed benchmark will report exact message/content/recipient/bucket/claim/attempt/snapshot counts, Node/PostgreSQL versions,
fixture seed, wall time, throughput, and latency quantiles. It excludes SMTP Internet latency, DNS, TLS, MIME/attachments, abuse,
mailbox/search, replication/failover, and production contention. One shared-runner observation cannot establish capacity or compare
Node versions fairly.
