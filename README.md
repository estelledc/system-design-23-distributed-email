# Distributed Email Service Lab

This clean-room system-design practice starts with one question: when one accepted message fans out to several recipients and a
worker or SMTP connection fails at an ambiguous boundary, what durable per-recipient receipts explain whether to retry without
calling remote acceptance “delivered,” “inbox,” or “read”?

The prompt title is “Distributed Email Service.” This repository does not copy an email product, source chapter, protocol
implementation, diagram, message, address list, DNS/signing material, benchmark, or proprietary behavior. The initial contract is
frozen from the title alone before reading the fixed secondary chapter.

## Current phase

The closed-book contract has been compared with the fixed secondary chapter and primary RFC/PostgreSQL documentation. v0.1 now has
an accepted design: one PostgreSQL authority, bounded per-recipient work, worker generations, attempt-before-I/O receipts, and a
real loopback TCP SMTP subset oracle. Implementation, executable validation, benchmark, public remote, and CI are still pending.

The slice intentionally stops at outbound remote-MTA acceptance. It does not implement inbound mail, mailbox storage, folders,
search, attachments, MIME interoperability, DNS/MX, TLS, authentication/signing, reputation, bounces, or Internet delivery.

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

## License

MIT. Third-party study material and real email, identity, DNS, credential, or provider data are not included.
