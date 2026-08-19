# Threat model

## Protected assets

- bearer authentication value and authenticated principal;
- synthetic envelope/header addresses and address digests;
- message subject/body/canonical bytes and content digest;
- stable request/message/recipient/attempt identities;
- queue timing, destination bucket, reply stages/codes, and oracle ledger;
- correctness of submission, suppression, lease, retry, terminal, and uncertainty receipts.

The public repository contains none of the values above from a real person, provider, domain, or company.

## Trust boundaries and controls

### HTTP caller to API

- exact bearer comparison, JSON content-type/body limit, closed object shapes, typed identifier/address grammar;
- no caller-provided arbitrary headers, SMTP commands, paths, SQL, retry class, worker generation, or success state;
- canonical digest plus durable request result prevents changed-intent replay;
- ordinary errors/logs do not echo message content or addresses.

### API/worker to PostgreSQL

- parameterized SQL and explicit transactions;
- unique/check/foreign-key constraints plus row/advisory locking;
- assignment, lease, attempt, and recipient revisions are rechecked at mutation time;
- database failure is not replaced with an in-memory accepted state.

### Worker to SMTP oracle

- loopback address and explicit port only; no DNS, MX, redirect, proxy, TLS downgrade, public egress, or caller-controlled host;
- generated constrained message; CRLF normalization and dot-stuffing occur in one implementation;
- numeric code/stage is stored, free-form remote text is discarded from control/log paths;
- timeout and byte/line bounds prevent indefinite or oversized dialogue.

### Operator/suppression boundary

- suppression is versioned, digest-keyed, and checked before attempt preparation;
- takeover increments a bucket generation and fences stale workers;
- uncertainty cannot be silently converted to remote acceptance or safe retry.

## Abuse cases kept out of scope

- open relay, account takeover, real bulk sending, spam/phishing/malware, tracking, credential harvesting;
- DNS rebinding/MX poisoning, TLS/PKI, SPF/DKIM/DMARC/ARC, bounce/complaint loops;
- MIME parser/rendering exploits, attachment decompression/malware, HTML/URL safety;
- public webhook/provider signatures, tenant billing/quotas, legal hold/export/deletion, or employee access workflows.

Those exclusions are not mitigations. A real service needs independent controls and evidence before any network or user data enters
scope.

## Verification hooks

- repository scan rejects local paths, credential patterns, co-author trailers, and realistic non-`.invalid` fixtures;
- unit tests cover header/newline injection, unknown fields, size/count limits, stable digest, and error redaction;
- integration tests cover changed-intent conflict, SQL concurrency, stale generation, suppression-before-I/O, and snapshot privacy;
- true-process smoke inspects structured logs and oracle digests, not addresses/content;
- GitHub Actions uses read-only contents permission, full action pins, locked dependencies, and a pinned PostgreSQL image digest.
