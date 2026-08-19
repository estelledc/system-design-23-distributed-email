# Operations guide

## Local commands

```bash
npm ci --ignore-scripts
npm run check
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/distributed_email npm run test:infra
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/distributed_email npm run smoke:infra
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/distributed_email npm run benchmark:infra
```

`compose.yaml` pins the same PostgreSQL 17.11 image digest as public CI. All fixtures use `.invalid` addresses and loopback sockets;
no command requires Internet SMTP or DNS. `npm run check` is the pure local gate; infrastructure commands require the real database
and fail rather than skip when it is missing.

## Health and invariant signals

`GET /v1/state` will expose only low-cardinality counts:

- queued, leased, attempting, retry-scheduled, remote-accepted, permanent-rejected, suppressed, dead-lettered, and uncertain;
- oldest due age and active/expired lease counts;
- attempts by typed outcome and bucket label;
- invariant gaps: recipients with more than one current attempt, invalid terminal scheduling, or assignment/lease mismatches;
- database reachability and process readiness.

Addresses, domains, message/request/recipient/attempt IDs, headers, subject/body, content/address digests, SMTP text, IPs, auth values,
and oracle ledger paths are prohibited in ordinary logs/metrics.

## Retry and overload

- PostgreSQL time decides due, lease, and recovery status.
- Default lab policy: at most three attempts; fixed deterministic short intervals in tests and configurable production-like values
  in code. A benchmark never changes these values implicitly.
- `4yz` and typed failures before message transfer may schedule retry. `5yz` is terminal for unchanged intent. Final-response loss is
  held as uncertainty.
- Claims are bucket-scoped and bounded. A busy bucket does not authorize stealing another bucket's generation.
- API body, recipients, content, active request count, lease length, page size, attempt count, and retained snapshot size are bounded.

## Recovery runbook

1. Stop the suspected stale worker; create/take over the bucket assignment and record the new generation.
2. Run one bounded recovery pass using PostgreSQL authority time.
3. Verify that prepared-only expired attempts were safely rescheduled, while `io_started` attempts moved to uncertainty.
4. Compare the synthetic oracle ledger only in the controlled lab. An oracle acceptance can calibrate the test, but no generic
   production operator may infer remote state from missing/partial local evidence.
5. Do not retry uncertainty automatically. A future explicit operator action must declare possible duplicate risk.

## Retention and cleanup

v0.1 keeps all bounded lab receipts. A future pruning job must preserve request/result and attempt identity longer than every
supported retry/client horizon, record a retention floor, and return an explicit beyond-horizon result. Deleting a row is never
converted into success.

## Alert candidates

- oldest due age grows while current workers exist;
- queue or uncertainty count increases across intervals;
- retry budget exhaustion or permanent rejection rate changes;
- expired leases or stale-generation rejects increase;
- invariant gap is nonzero;
- database unavailable, oracle unavailable in tests, or CI infrastructure test skipped (which must fail the gate).

These are operator candidates, not a production SLO or proof of inbox delivery.
