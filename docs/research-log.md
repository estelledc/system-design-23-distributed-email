# Source comparison and evidence log

## Evidence policy

The initial contract at commit `9458ff9b08bea598fcc77d1390ddf9f1638b00e8` was written from the title alone. The secondary
repository has no detected license at fixed commit `9d8388721e7231442763ad37398b8d82224aa68f`, so this repository copies no
prose, diagrams, schemas, code, fixtures, or benchmark values. Sources challenge the closed-book contract and calibrate independently
written decisions.

Search discovery is not verification. One `journal-search public` query returned the intended repository through both Exa and the
GitHub adapter. The exact chapter path/blob was then resolved through the GitHub tree API; its raw fixed-commit URL and every primary
page below were acquired into separate bundles whose verification result was valid. TraceFetch receipts are unsigned local
acquisition diagnostics, not third-party attestations or proof that a source's claims are true.

## Fixed secondary chapter

- Source: [`liquidslr/system-design-notes`, chapter 23](https://github.com/liquidslr/system-design-notes/blob/9d8388721e7231442763ad37398b8d82224aa68f/23.%20Distributed%20Email%20Service/README.md)
- Tree commit: `9d8388721e7231442763ad37398b8d82224aa68f`
- Chapter blob: `60ae9c946d0e042982b7f884110d34a0b53227f6`
- TraceFetch receipt: `tf_e690211246a55e4a_20260819T011020Z`
- Raw SHA-256: `e690211246a55e4a43b4690392725956d7a231e31d557b2d2776dc1aca9d4b2d`
- Verification: valid, HTTP 200, complete, not truncated; license remains unresolved, so the content is reference-only.

### Confirmed by the chapter

- HTTP can be the product-facing API while SMTP remains an inter-server transfer protocol; those boundaries should not share one
  success label.
- A durable outgoing queue decouples submission from delivery workers, and queue age/depth is an operational signal rather than a
  delivery receipt.
- Recipient-server unavailability needs delayed retry; a hot or growing queue may also mean insufficient workers.
- Message metadata, large attachments, cache, full-text search, realtime notification, and mailbox storage have different access
  patterns and should not be forced into one store.
- Sender reputation, abuse controls, complaint feedback, and authentication materially affect deliverability, but are separate
  domains that require their own evidence.
- Most mailbox reads are user-local, while multi-datacenter failover, backup, privacy, and security remain explicit design topics.

### Added after reading

- v0.1 deliberately selects one outbound slice rather than reproducing the chapter's entire webmail, inbound SMTP, mailbox,
  attachment, search, realtime, and multi-DC architecture.
- The chapter's rough billion-user arithmetic is retained only as a discussion point. This lab uses its own hypothetical scale
  envelope to choose limits and publishes no current Gmail/Outlook population or production-capacity claim.
- One SMTP transaction per recipient makes partial results and recovery visible. Batching recipients could improve throughput, but
  creates a harder mapping between one final DATA reply and multiple RCPT outcomes that is not needed for the first invariant.

### Conflicts and corrections

1. The proposed send API says routing comes from `To`, `Cc`, and `Bcc` headers. RFC 5322 distinguishes message content from the
   transport envelope, and Bcc handling can remove the visible field. v0.1 stores envelope recipients separately and never derives
   routing authority from display headers.
2. “Sent Emails” appears after enqueuing without a state definition. A sent-folder copy can mean user intent was durably accepted;
   it cannot mean a remote MTA, mailbox, inbox, renderer, or person accepted the message.
3. The inbound flow says invalid accepted mail can be directly discarded. RFC 5321 makes a positive completion after final DATA a
   transfer of responsibility; a policy rejection belongs in the SMTP transaction, or later failure/drop needs its own prescribed
   handling and evidence.
4. The POP summary implies retrieval automatically deletes server mail. RFC 1939 defines explicit `DELE` marking and removal in the
   UPDATE state; download-and-delete is a common policy, not an unconditional protocol effect.
5. The attachment statement treats base64 as universal. RFC 2045 defines multiple content-transfer-encodings, including 7bit,
   8bit, binary, quoted-printable, and base64. v0.1 excludes MIME/attachments rather than implementing an incorrect subset silently.
6. Invalid API input is routed to an error queue. Deterministically invalid bounded input should be synchronously rejected; a queue
   is not evidence that poison work can ever become valid.
7. “Exponential backoff” alone omits reply/stage classification, durable authority time, configurable retry age/attempt bounds,
   per-destination pressure, and terminal state. v0.1 makes these decisions typed and versioned.
8. Attachment identity by filename is not unique or immutable. A future attachment design needs a content digest/object generation,
   size/media policy, authorization, reference lifecycle, and malware/quarantine receipt.
9. A time-based message identifier does not by itself provide idempotent submission, immutable content binding, stable pagination,
   or safe clock ordering. v0.1 separates request key, message identity, content digest, recipient ordinal, and snapshot identity.
10. “Trade availability for consistency” and a leader/follower diagram do not define acknowledgement quorum, replication lag,
    failover fencing, RPO/RTO, read semantics, or split-brain prevention. v0.1 makes no HA/DR claim.
11. Dedicated IP and a fixed warm-up duration are operational/vendor heuristics, not universal protocol guarantees. The lab excludes
    public sending and records reputation/inbox placement as unproved.
12. The chapter does not name the final-reply-loss window. RFC 5321 warns that a spurious timeout awaiting final `250` can cause
    duplicate delivery. v0.1 records `unknown_after_io` and does not automatically retry it.

### Important omissions

- stable submission identity, immutable intent digest, atomic bounded recipient fan-out, and original-result replay;
- per-recipient mixed outcomes instead of a message-level sent/delivered boolean;
- worker lease/assignment generations and stale-worker fencing;
- a durable attempt before network I/O and monotonic SMTP stage receipts;
- explicit connect/greeting/MAIL/RCPT/DATA/final-reply failure classification;
- final-DATA response-loss ambiguity, possible duplicate policy, finite retry age/attempts, and dead letter;
- suppression before I/O, destination-bucket fairness, retention horizon, and immutable status snapshots;
- header/control-character/dot-framing limits and privacy-bounded observability;
- a receipt chain separating remote-MTA acceptance from mailbox storage, inbox placement, display, read, consent, and external
  acceptance.

## Primary calibration sources

### RFC 5321 — SMTP

- Official page: <https://www.rfc-editor.org/rfc/rfc5321.html>
- Receipt: `tf_5df422fb9940f265_20260819T011051Z`
- SHA-256: `5df422fb9940f2659fbf468d2a9f78fc8aebc2eec63f92a9dc598b4630ad48aa`
- Applied decision: final `2yz` after DATA means the peer accepted responsibility; `4yz` leaves responsibility with the client
  and permits requeue, while `5yz` should not be retried unchanged. Timeouts awaiting final `250` can create duplicates. The lab
  records stages/codes, keeps one recipient per transaction, and leaves reply-loss cases uncertain.

### RFC 3463 — enhanced mail status codes

- Official page: <https://www.rfc-editor.org/rfc/rfc3463.html>
- Receipt: `tf_428d7af383f03c62_20260819T011053Z`
- SHA-256: `428d7af383f03c62b414a49766fa231063fd08c155180fd11e7113453a89c2e2`
- Applied decision: class 4 is persistent transient failure and class 5 is permanent failure. v0.1 accepts a tiny numeric subset as
  evidence but controls retry primarily from the SMTP reply class/stage; it does not claim DSN or enhanced-code compatibility.

### RFC 5322 — Internet message format

- Official page: <https://www.rfc-editor.org/rfc/rfc5322.html>
- Receipt: `tf_f56811068b3c14a1_20260819T011055Z`
- SHA-256: `f56811068b3c14a15e52ebd800ba7a03e7c10ef68eb9a2e07dee96d7cba0a261`
- Applied decision: envelope and message content are separate; From/To/Bcc/Message-ID are content fields with different semantics.
  The lab generates a constrained ASCII message and keeps authenticated principal, envelope sender/recipient, and visible headers
  distinct. It does not advertise complete RFC 5322 compatibility.

### RFC 1939 — POP3

- Official page: <https://www.rfc-editor.org/rfc/rfc1939.html>
- Receipt: `tf_3f8666423bdc17b1_20260819T011222Z`
- SHA-256: `3f8666423bdc17b16d6d4889b9e17ea8b07e3823d154728a15fb5ee194b349e0`
- Applied decision: used only to correct the secondary chapter's automatic-deletion summary. POP, IMAP, mailbox retrieval, and
  deletion are outside this executable slice.

### RFC 2045 — MIME Part One

- Official page: <https://www.rfc-editor.org/rfc/rfc2045.html>
- Receipt: `tf_e81f95ccab5b2630_20260819T011224Z`
- SHA-256: `e81f95ccab5b263087e259e197bfea6a86dc4c06ea4bbe993ac46a0253285a5f`
- Applied decision: the existence of multiple content-transfer-encodings invalidates a universal base64 assumption. v0.1 accepts no
  attachments and generates only bounded 7-bit-like ASCII content; this is a lab restriction, not MIME compatibility.

### PostgreSQL 17 transaction isolation

- Official page: <https://www.postgresql.org/docs/17/transaction-iso.html>
- Receipt: `tf_70cf332f46ff2d05_20260819T011208Z`
- SHA-256: `70cf332f46ff2d0537fe7706a7922fee9f1d8092fe98a8ea05947fe7cc1c769d`
- Applied decision: mutations use short explicit transactions and row/advisory locks; immutable status snapshots are materialized
  in one transaction instead of combining multiple Read Committed statements into a fictional point-in-time view.

### PostgreSQL 17 explicit locking

- Official page: <https://www.postgresql.org/docs/17/explicit-locking.html>
- Receipt: `tf_dc13a9df72216e8b_20260819T011210Z`
- SHA-256: `dc13a9df72216e8bde3a9b6a4640493a6af8436c2ce7f06023bbce41e06cac44`
- Applied decision: row locks and stable acquisition order serialize recipient claims/completions; assignment generations fence a
  stale worker. Network I/O never occurs while a database transaction or row lock is held.

### RFC 9110 — HTTP semantics

- Official page: <https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods>
- Receipt: `tf_d431760660ea44e1_20260819T011213Z`
- SHA-256: `d431760660ea44e130f6e919dab216df2d0b3a490567a98089267523368fe1e5`
- Applied decision: POST is not made retry-safe by wishful method semantics. The API requires an application request key, immutable
  digest, durable original result, and changed-intent conflict.

## Evidence boundary after calibration

The source review supports a bounded outbound-queue experiment with a real loopback SMTP dialogue. It does not prove SMTP/ESMTP,
MIME, DSN, POP/IMAP/JMAP, DNS/MX, SPF/DKIM/DMARC, TLS, provider, mailbox, attachment, search, reputation, deliverability, complaint,
unsubscribe, legal, multi-region, production-capacity, SLA, deployment, inbox, read, human, or external acceptance behavior.
