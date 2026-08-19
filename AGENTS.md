# Repository instructions

- This is an independent clean-room learning repository for one bounded distributed-email invariant.
- Keep API validation, durable message acceptance, per-recipient queue ownership, SMTP command acceptance, final DATA acceptance,
  mailbox visibility, inbox placement, display, read, complaint, and external acceptance as separate facts.
- Never add real credentials, sender/recipient addresses, message content, contact lists, domains, DNS records, signing keys,
  production provider data, internal topology, or copied third-party prose, diagrams, fixtures, benchmarks, or code.
- Preserve unrelated work. Stage exact paths, keep commits single-purpose, and do not add co-author trailers unless requested.
- Infrastructure conclusions require a real database/process/TCP boundary in public CI; mocks cannot prove durable queue ownership,
  lease fencing, SMTP response-loss behavior, retry scheduling, or per-recipient outcomes.
- A benchmark is a bounded synthetic observation for its exact fixture and runtime, never deliverability, reputation, throughput,
  SLA, inbox placement, or production-capacity evidence.
