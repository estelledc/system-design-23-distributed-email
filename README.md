# Distributed Email Service Lab

This clean-room system-design practice starts with one question: when one accepted message fans out to several recipients and a
worker or SMTP connection fails at an ambiguous boundary, what durable per-recipient receipts explain whether to retry without
calling remote acceptance “delivered,” “inbox,” or “read”?

The prompt title is “Distributed Email Service.” This repository does not copy an email product, source chapter, protocol
implementation, diagram, message, address list, DNS/signing material, benchmark, or proprietary behavior. The initial contract is
frozen from the title alone before reading the fixed secondary chapter.

## Current phase

Closed-book contract only. Source comparison, standards review, storage/queue/SMTP choice, implementation, tests, benchmark,
public remote, CI, deployment, deliverability, SLA, and external acceptance are pending.

Candidate concerns include immutable message content, envelope/header separation, per-recipient fan-out, leases/fencing, retry and
terminal status classes, response-loss ambiguity, suppression, bounded privacy logs, stable queries, and evidence separation. They
remain hypotheses until source review and executable validation.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Security policy](SECURITY.md)

## Evidence boundary

API validation, durable acceptance, queued recipient, claimed attempt, TCP/TLS connection, SMTP command reply, final DATA reply,
remote-MTA responsibility, mailbox availability, inbox placement, display, read, complaint, and business acceptance are different
facts. This lab will name and test only the boundaries it reaches. It will abstain from real delivery, inboxing, opens, reputation,
compliance, SLA, or external acceptance without matching evidence.

## License

MIT. Third-party study material and real email, identity, DNS, credential, or provider data are not included.
