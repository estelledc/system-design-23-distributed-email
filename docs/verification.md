# Verification ledger

## Identity-safe history

The identity-safe rewrite preserved every existing tree, message, and timestamp while mapping the four commits in order:

- `9458ff9b08bea598fcc77d1390ddf9f1638b00e8` → `eefce545fc6e56617229b3145c0f04c7e9d0f13b`
- `9ed778ba0aaa553a6072e2c9116e4094827548e0` → `8b93f87a4afeeea3ef0e9d6b3f2b9d49bff4a0e5`
- `b367fbb72e77b8615fcc18d885d3faaf6c621621` → `de3769569224985eb306dfc030e8fb7a48b2dfa3`
- `488a75890c538b2f81e9aa23b713dd94076a7705` → `e3be44b0c1551e182e5f0aac09c84c12a30fc1d6`

Current reachable `main` uses the repository owner's GitHub noreply identity. Rewritten baseline
`e3be44b0c1551e182e5f0aac09c84c12a30fc1d6` passed [CI run 32228609897](https://github.com/estelledc/system-design-23-distributed-email/actions/runs/32228609897)
on Node 22/24/26 with PostgreSQL 17.11, the loopback SMTP oracle, and the complete gate.

## Evidence levels

| Claim | Required evidence | Current state |
|---|---|---|
| closed-book invariants predate source reading | first Git commit | passed: `eefce545fc6e56617229b3145c0f04c7e9d0f13b` |
| fixed chapter and primary pages were acquired completely | fixed identities, SHA-256, valid receipts | passed; see research log |
| validation/digest/state-machine logic | deterministic unit/property tests | local pass: 11 tests, 0 skipped/failed/todo |
| atomic fan-out, claim, retry, fencing, snapshots | real PostgreSQL 17 integration tests | local pass: 7 tests, 0 skipped/failed/todo |
| SMTP stage and disconnect behavior | real loopback TCP oracle | local pass: `250`, `451`, `550`, accepted-without-reply |
| response-loss recovery | real API/worker `SIGKILL` processes plus database/oracle readback | local pass: four killed processes |
| bounded performance observation | fixed fixture/runtime/service versions and raw JSON | local pass: Node 26.7.0 + PostgreSQL 17.11 |
| reproducible remote default branch | public commit plus green Node 22/24/26 CI | implementation commit/run passed; receipt update pending its own run |

## Historical public implementation receipt

- Repository: <https://github.com/estelledc/system-design-23-distributed-email>
- Pre-rewrite implementation object: `b367fbb72e77b8615fcc18d885d3faaf6c621621`; current tree-equivalent commit:
  `de3769569224985eb306dfc030e8fb7a48b2dfa3`
- Historical CI run: [32205914983](https://github.com/estelledc/system-design-23-distributed-email/actions/runs/32205914983); it remains bound to the old object
- Jobs: Node 22 `95929062259`, Node 24 `95929062353`, Node 26 `95929062236`; all completed successfully against the
  PostgreSQL 17.11 image pinned by digest.
- Each job ran 11 pure tests and 7 real PostgreSQL/TCP tests with `0` failed, skipped, or todo; repository policy/syntax/link scans,
  locked install, and high-severity dependency audit also passed with zero reported vulnerabilities.
- Each job reproduced four true-process kills: submission response loss, prepared-attempt crash before I/O, final-`250`/local-
  commit loss, and transient-completion response loss. Each also rejected a stale assignment before TCP and ended with invariant
  gap zero; mailbox, inbox, read, and external acceptance remained explicitly false.

The fixed shared-runner benchmark observed the following ranges across the three concurrent jobs. These are raw observations, not
runtime rankings or production estimates:

| Observation | Public range |
|---|---:|
| submission throughput | 416.409–483.900 messages/s |
| attempt-receipt throughput | 35.152–86.057 attempts/s |
| submission p50 | 11.802–14.209 ms |
| attempt p50 | 6.698–7.582 ms |
| snapshot p50 | 1.863–2.087 ms |

The exact fixture was 64 messages × 4 recipients, 256 completed synthetic attempt receipts, 4 buckets, and 32 immutable status
snapshots. It excluded public SMTP, DNS/MX, TLS, MIME/attachments, mailbox/inbox/read, replication/failover, production contention,
deliverability, SLA, and external acceptance.

## Pure-test matrix

- exact input schema, `.invalid` address grammar, identifier/body/header/line/recipient limits, CRLF/dot handling;
- canonical intent/content/address digests, ordered recipient semantics, changed-intent conflict;
- recipient transition graph, attempt-number/retry-age bounds, deterministic backoff, SMTP stage/code classification;
- message projection for all-queued, all-remote-accepted, mixed, uncertain, and terminal recipient sets;
- HTTP authentication, errors, body limits, route shutdown, and log redaction.

## PostgreSQL/TCP matrix

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

## True-process crash smoke

1. API commits submission then receives `SIGKILL` before response; restart/exact replay returns revision 1.
2. Worker commits a prepared attempt then receives `SIGKILL` before I/O; oracle connection count stays zero and recovery safely
   reschedules the same recipient.
3. Worker receives oracle final `250`; oracle fsyncs one acceptance, then worker receives `SIGKILL` before local completion. Recovery
   records `unknown_after_io`, local `remote_accepted` stays false, and no automatic duplicate is sent.
4. Worker commits a `451` retry schedule then receives `SIGKILL`; restart observes exactly one completed attempt and one schedule.
5. A stale worker generation is rejected before opening TCP after a takeover.

The local receipt reports four killed processes, exact submission revision 1, zero oracle transaction before the prepared-attempt
crash, one fsynced oracle acceptance followed by local uncertainty, one committed transient attempt/retry schedule, stale-generation
rejection before TCP, zero invariant gap, and explicit false mailbox/inbox/read/external-acceptance fields.

## Benchmark boundary

The fixed benchmark reports exact message/content/recipient/bucket/claim/attempt/snapshot counts, Node/PostgreSQL versions,
fixture seed, wall time, throughput, and latency quantiles. It excludes SMTP Internet latency, DNS, TLS, MIME/attachments, abuse,
mailbox/search, replication/failover, and production contention. One shared-runner observation cannot establish capacity or compare
Node versions fairly.

One local Node 26.7.0 / PostgreSQL 17.11 run used 64 messages, 4 recipients each, 256 completed synthetic attempt receipts, 4
buckets, and 32 status snapshots. It observed 1,021.685 message submissions/s and 337.898 attempt transactions/s, with submit p50
5.939 ms, attempt p50 1.852 ms, and snapshot p50 0.537 ms. This is one development-machine observation, not an SMTP throughput,
deliverability, capacity, or SLA claim; public CI will retain its own raw per-runtime observations.

## Failures found before publication

- The first real TCP suite passed all six business tests but failed the file after completion because the oracle left a reset socket
  error unhandled. The oracle now absorbs expected connection resets without logging peer data and destroys tracked sockets on
  shutdown; the complete suite then passed.
- After lease-deadline fencing was tightened, a 50 ms integration fixture expired during ordinary local database calls. The test now
  uses a 150 ms lease and a 250 ms expiry wait; product code still rejects I/O start/completion after authority-time expiry.
