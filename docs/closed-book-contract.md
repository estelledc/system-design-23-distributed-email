# Closed-book contract: receipted per-recipient attempts and bounded external ambiguity

## Reading boundary

This contract was written from the case title alone, before reading the fixed `system-design-notes` chapter. “Distributed Email
Service” names a problem family, not one product, SMTP profile, mailbox provider, campaign system, or delivery guarantee. Message
submission, MIME construction, DNS, SMTP relay, queues, retries, bounce processing, suppression, signing/authentication, mailbox
storage, search, spam filtering, tracking, and compliance are hypotheses for this lab—not facts about Gmail, Outlook, SES,
SendGrid, Postfix, Exim, Exchange, or any other service. Later research must record confirmations, conflicts, omissions, and changes
instead of silently rewriting this baseline.

## Users and core behavior

### Synthetic sender

1. An authenticated caller submits one bounded synthetic message under a stable request/message identity and immutable canonical
   content/envelope digest.
2. A successful API response states whether input was validated, durably accepted, and expanded into per-recipient work. It never
   says delivered, inboxed, displayed, read, or accepted by a person.
3. Exact retry returns the original receipt. Reusing a request/message identity with changed sender, recipients, headers, or content
   conflicts. Removing/reordering recipients is changed intent unless canonical set/order policy explicitly says otherwise.
4. Message-level status is a projection of recipient-level facts; one recipient's success cannot hide another's retry/dead letter.

### Delivery worker/operator

1. A worker claims bounded recipient work under a lease/assignment generation and records attempt number, route generation, and
   next decision time.
2. A stale worker cannot publish a current result or schedule another retry after takeover.
3. Each SMTP stage has its own receipt. Connection, greeting, envelope sender, one recipient command, DATA initiation, and final
   server reply are not collapsed into one boolean.
4. Ordinary health exposes queue depth/age, retry/terminal counts, lease expiry, domain-bucket pressure, and invariant status without
   addresses, domains, message IDs, subjects, content, headers, response text, or credentials.

### Recipient-status consumer

1. A bounded query materializes one message snapshot with every recipient's current generation/state and attempt receipts.
2. Pagination under one query identity cannot mix recipient revisions.
3. `queued`, `leased`, `retry_scheduled`, `remote_accepted`, `permanent_rejected`, `suppressed`, `dead_lettered`, `unknown_after_io`,
   `retained_away`, and “no such message” remain distinct.

### Mailbox, trust, compliance, or analytics consumer

1. A remote SMTP `2xx` may mean the peer accepted responsibility under the negotiated protocol; it does not prove a mailbox row,
   inbox placement, display, read, human identity, consent, or business outcome.
2. SPF, DKIM, DMARC, TLS policy, reputation, abuse prevention, consent, unsubscribe, legal basis, bounce/complaint feedback,
   tracking/open/click analytics, and retention require independent systems and receipts.
3. v0.1 exposes no real delivery or engagement claim.

## Non-goals for v0.1

- real senders, recipients, contacts, domains, DNS, SMTP hosts, credentials, signing keys, provider accounts, message bodies,
  attachments, bounces, complaints, tracking pixels/links, campaigns, templates, production traffic, or operational data;
- mailbox hosting, inbound Internet mail, IMAP/POP/JMAP, webmail, address books, search, threads, drafts, folders, spam/phishing/
  malware detection, rendering, encryption, key management, or end-user authentication;
- standards/vendor compatibility claims for SMTP/ESMTP, MIME, DSN, SPF, DKIM, DMARC, ARC, MTA-STS, DANE, S/MIME, OpenPGP, or
  any provider API;
- Internet DNS/MX lookup, public network egress, real TLS/PKI, multi-region consensus, arbitrary routing, production backup/restore,
  deployment, SLA, reputation, compliance, inbox placement, or capacity claims;
- unbounded content/header/recipient size, retry count/age, queue/domain cardinality, lease, query, receipt history, or retention;
- proving remote mailbox existence, human ownership, delivery, inbox placement, display/read, unsubscribe, complaint handling,
  marketing legality, external acceptance, or business impact.

## Hypothetical scale envelope

These numbers select failure modes; they are not sourced requirements:

- ten million accepted messages/day is about 116 messages/s average; a 20× burst is about 2,315 messages/s;
- with 2.5 recipients/message, fan-out is 25 million recipient jobs/day, about 289/s average;
- at a hypothetical 12 KiB canonical message, one content copy/message is about 120 GB/day before metadata, indexes, WAL, receipts,
  replicas, compression, and retry history;
- three content copies are about 360 GB/day; duplicating content per recipient would multiply the dominant component again;
- 1% transient retries is 250,000 extra attempts/day; even 0.01% ambiguous post-DATA disconnects is 2,500 cases/day requiring an
  explicit uncertainty policy;
- one hot destination domain receiving 30% of work is a domain-local fairness/reputation hotspot despite modest global average.

The runnable lab will use a small loopback-only synthetic fixture, report exact messages/recipients/attempts/retries/acceptances/
ambiguities, and never extrapolate it to an Internet mail service.

## Candidate data and state model

Message and submission identity:

```text
tenant + message_id -> immutable envelope/header/content/recipient digest + durable acceptance receipt
principal + request_key + operation -> immutable intent digest + original result
content_digest -> immutable bounded content bytes (one copy, reference-counted by message)
```

Recipient work:

```text
message_id + recipient_ordinal/address_digest -> one recipient record
queued -> leased(generation, deadline) -> attempting(attempt_id)
  -> remote_accepted
  -> retry_scheduled(next_attempt_at)
  -> permanent_rejected | suppressed | dead_lettered
  -> unknown_after_io (explicit operator policy required)
```

Attempt receipt:

```text
attempt_id -> route_generation + worker_generation + started_at
          -> connection/greeting/mail/rcpt/data/final-reply stages
          -> typed classification + next state
```

Envelope sender/recipient controls routing. Header `From`/`To` are content fields and cannot silently replace the envelope.

## Core invariants

1. **Stable submission intent.** One request/message ID binds sender, ordered/canonical recipients, headers, content digest, policy
   generation, and limits. Exact retry replays; changed intent conflicts.
2. **Content is immutable and shared.** One accepted message points to one content digest/length. Recipient retries cannot mutate or
   duplicate the canonical content silently.
3. **Envelope and headers differ.** SMTP envelope identities, visible header identities, Message-ID, return path, and authenticated
   principal have distinct fields and validation. A header cannot authorize an envelope sender.
4. **Fan-out is atomic at acceptance boundary.** Durable message acceptance creates the full bounded recipient set and work rows in
   one transaction/protocol, or the API does not claim acceptance.
5. **Every recipient is independent.** One recipient's attempt/state cannot overwrite or summarize away another's outcome.
6. **One active owner per recipient generation.** Lease and assignment generations fence stale workers. Takeover can replay work,
   but the old worker cannot publish a current classification.
7. **Attempt identity is stable before I/O.** The durable attempt/route/recipient/generation receipt exists before opening the TCP
   session, so a crash can explain which external effect is ambiguous.
8. **Protocol stages are monotonic facts.** A later receipt may add evidence but cannot rewrite a prior server reply. Greeting,
   MAIL, RCPT, DATA start, content transfer, and final reply remain distinguishable.
9. **Final DATA success is remote acceptance only.** It proves neither mailbox storage nor delivery, inbox placement, display, read,
   identity, consent, or business outcome.
10. **Response-loss ambiguity is explicit.** Disconnect after content transfer but before a final reply is not labelled success or
    safe retry. Policy can retry with possible duplicate, hold for reconciliation, or dead-letter—never invent certainty.
11. **Retry classification is bounded and versioned.** Reply class/code, network phase, attempt count, age, route policy, and next
    schedule determine retry/terminal state. Free-form response text is evidence, not control input/log output.
12. **Backoff uses durable authority time.** `next_attempt_at`, lease expiry, and attempt deadlines come from the durable authority;
    client/worker clocks cannot seize or release work.
13. **Retry budget is finite.** Max attempts, max age, per-domain concurrency/rate, and dead-letter behavior are explicit. Poison
    work cannot loop forever or starve unrelated domains.
14. **Domain fairness is isolated.** A hot/throttled domain cannot consume every worker/lease. Route/domain generation is versioned,
    and global FIFO is not promised.
15. **Suppression precedes external I/O.** A versioned suppression/consent policy, if implemented, is checked under the same claim
    generation before attempt. v0.1 may support only an operator synthetic suppression list.
16. **Duplicate external delivery cannot be ruled out by local exactly-once.** Local state/attempt commits can be unique while an
    ambiguous retry creates two remote copies. Receipts name the boundary.
17. **One query, one snapshot.** Message/recipient/attempt pages bind one materialized revision. Later retries cannot alter earlier
    query pages.
18. **Missing states are not success.** No recipient, not yet attempted, lease lost, network unknown, response retained away, and
    remote rejection are distinct from remote acceptance.
19. **Retention preserves recovery.** Submission receipts, terminal recipient states, and attempt identities outlive every supported
    client/worker retry horizon. After pruning, return explicit beyond-horizon status.
20. **Backpressure is visible.** Submission, content, recipient fan-out, per-domain queue, worker, TCP, retry, query, and storage
    limits reject/throttle with typed receipts; timeout/drop is never called accepted.
21. **No header/protocol injection.** Address/header/content validation rejects control characters, bare newline ambiguity, unknown
    fields, overlong lines/content, dot-framing ambiguity, and unsupported encodings before durable acceptance.
22. **Evidence is privacy-bounded.** Ordinary logs/metrics omit addresses/domains, message/recipient/attempt IDs, subjects, content,
    headers, digests, response text, auth values, IPs, DNS, and provider data.
23. **Self-monitoring is not delivery proof.** Queue/worker health needs an independent state read; a dashboard served by the same
    stalled projector cannot prove progress, and no local metric proves mailbox delivery.

## Initial API and event sketch

Submission/query routes:

- `POST /v1/messages` with stable message ID, synthetic envelope/header identities, bounded recipient list/content, and request key;
- `GET /v1/messages/{id}` for durable acceptance/state without content echo;
- `POST /v1/status-queries` and immutable pages bound to one message revision;
- `GET /v1/mutation-receipts/{id}` for response-loss recovery.

Worker/operator routes:

- `POST /v1/worker-assignments` with expected generation and bounded domain bucket;
- `POST /v1/recipient-claims` with current generation and durable lease;
- `POST /v1/attempts/{id}/complete` with exact protocol-stage receipt and expected recipient revision;
- `POST /v1/suppressions` and `/v1/retries` only under explicit policy generations;
- `GET /v1/state` for low-cardinality queue/lease/retry/terminal/invariant signals.

Exact address/header/content grammar, SMTP subset, route/domain partitioning, reply classification, attempt/lease duration, retry
schedule, suppression, storage, auth, error vocabulary, and retention remain hypotheses until primary standards are reviewed.

## Failure matrix

| Failure window | Required result |
|---|---|
| caller loses response after durable submission | exact key/digest returns original message/recipient acceptance receipt |
| same key/message arrives with changed recipients/content | typed conflict; never another implicit message |
| crash after message row before recipient fan-out | transaction rolls back or recovery completes full set before accepted claim |
| two workers claim one recipient | one current lease generation; loser cannot start/publish current attempt |
| old worker returns after takeover | generation fence rejects classification/retry scheduling |
| crash after durable attempt before TCP | lease recovery reuses/explains attempt; no external effect claimed |
| disconnect before any final DATA reply | stage-specific network result; no remote acceptance claim |
| peer returns final success then worker dies before local commit | remote effect is ambiguous locally; policy and possible-duplicate risk are explicit |
| transient reply repeats until budget exhausted | durable schedule advances and ends in dead letter; no infinite hot loop |
| one recipient permanently rejects | other recipients continue; message summary stays partial/mixed |
| recipient becomes suppressed before claim | current generation records suppression without opening TCP |
| status page races a retry | every page remains bound to one materialized revision |
| receipt/attempt history was pruned | explicit beyond-retention result; no invented retry safety |
| remote accepts message | receipt says remote accepted only; no mailbox/inbox/display/read claim |

## Required executable evidence before v0.1 completion

1. A clean-room README, source comparison, requirements, architecture, API/events, operations, threat model, and at least one ADR.
2. Exact address/header/content/message/recipient/attempt validation, canonical digest, error vocabulary, and privacy tests.
3. Generated/property tests for fan-out conservation, per-recipient state transitions, retry bounds/backoff, stage monotonicity,
   lease fencing, response-loss classification, and snapshot-stable queries.
4. Real persistence/concurrency tests for atomic submission/fan-out, exact/changed retry, competing claims, takeover fencing, durable
   attempt-before-I/O, retry scheduling, suppression, mixed recipient outcomes, terminal retention, and restart.
5. A real loopback TCP SMTP-subset oracle and true-process crashes covering submission response loss, claim/attempt ambiguity, final
   reply/local-commit loss, retry takeover, and explicit non-delivery evidence.
6. A bounded benchmark with exact messages/content bytes/recipients/domains/claims/attempts/retries/acceptances/ambiguities, runtime/
   service versions, exclusions, and raw observations—without deliverability, reputation, SLA, or capacity extrapolation.
7. Public multi-runtime CI with pinned actions/services, dependency audit, zero skipped infrastructure tests, and exact commit/run
   receipts.
8. Privacy/evidence scans that reject realistic addresses/domains/content/credentials and any claim of delivery, inbox/read,
   compliance, SLA, or external acceptance without matching evidence.

## Initial design choices to challenge after source review

- Does the chapter distinguish envelope identities, visible headers, content identity, and authenticated sender authority?
- Is durable API acceptance atomic with complete per-recipient fan-out?
- What state/lease generation prevents two workers or a stale worker from publishing one recipient result?
- Is an attempt identity durable before TCP I/O, and are SMTP stages recorded separately?
- What exactly does a final server success prove, and how is disconnect-after-DATA ambiguity represented?
- Are transient/permanent reply classes, enhanced codes, network stages, backoff, max attempts/age, and dead letter deterministic?
- Can one hot/throttled destination domain starve all other work?
- Are suppression, consent, unsubscribe, complaint, reputation, SPF/DKIM/DMARC/TLS, mailbox delivery, inbox placement, display/read,
  and external acceptance kept outside the local queue success claim?
