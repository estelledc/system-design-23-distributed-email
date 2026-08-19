# Distributed Email Service Lab

This clean-room system-design practice starts with one question: when one accepted message fans out to several recipients and a
worker or SMTP connection fails at an ambiguous boundary, what durable per-recipient receipts explain whether to retry without
calling remote acceptance “delivered,” “inbox,” or “read”?

The prompt title is “Distributed Email Service.” This repository does not copy an email product, source chapter, protocol
implementation, diagram, message, address list, DNS/signing material, benchmark, or proprietary behavior. The initial contract is
frozen from the title alone before reading the fixed secondary chapter.

## Current phase

The closed-book contract has been compared with the fixed secondary chapter and primary RFC/PostgreSQL documentation. The v0.1
vertical slice is implemented and has passed its local pure, PostgreSQL, real loopback TCP, true-process crash, policy, audit, and
fixed benchmark gates. A public remote and independent GitHub Actions receipt are still pending, so local success is not yet the
release result.

The slice intentionally stops at outbound remote-MTA acceptance. It does not implement inbound mail, mailbox storage, folders,
search, attachments, MIME interoperability, DNS/MX, TLS, authentication/signing, reputation, bounces, or Internet delivery.

## What runs

```text
HTTP submission -> PostgreSQL atomic message + recipient fan-out
                 -> bucket assignment + recipient lease
                 -> prepared attempt -> committed io_started boundary
                 -> real loopback TCP SMTP dialogue
                 -> per-recipient remote/retry/reject/unknown receipt
```

The loopback oracle fsyncs only address/content digests before returning final `250`. If the worker receives that reply and is then
`SIGKILL`ed before its local completion commit, recovery reports `unknown_after_io`; it does not automatically send a possible
duplicate or label the message delivered.

## Run the gates

```bash
npm ci --ignore-scripts
npm run check
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/distributed_email npm run test:infra
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/distributed_email MAIL_API_TOKEN=synthetic-token npm run smoke:infra
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/distributed_email npm run benchmark:infra
```

`compose.yaml` pins PostgreSQL 17.11. Infrastructure commands fail rather than skip when the database is absent. The SMTP oracle
binds loopback only; no test performs DNS or public mail delivery.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [API contract](docs/api.md)
- [Research log](docs/research-log.md)
- [ADR 0001](docs/adr/0001-postgres-recipient-attempt-authority.md)
- [Operations](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [Verification ledger](docs/verification.md)
- [Security policy](SECURITY.md)

## Evidence boundary

API validation, durable acceptance, queued recipient, claimed attempt, TCP/TLS connection, SMTP command reply, final DATA reply,
remote-MTA responsibility, mailbox availability, inbox placement, display, read, complaint, and business acceptance are different
facts. This lab will name and test only the boundaries it reaches. It will abstain from real delivery, inboxing, opens, reputation,
compliance, SLA, or external acceptance without matching evidence.

Current local evidence proves exact submission replay, changed-intent conflict, atomic fan-out, bucket/lease fencing, suppression
before I/O, finite retries, immutable status pages, numeric SMTP stage classification, four real `SIGKILL` recovery windows, and a
bounded single-machine benchmark. It does not prove PostgreSQL failover, SMTP/MIME compatibility, Internet delivery, mailbox
storage, inbox placement, read, reputation, production capacity, SLA, deployment, or external acceptance.

## License

MIT. Third-party study material and real email, identity, DNS, credential, or provider data are not included.
