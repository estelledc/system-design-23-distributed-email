CREATE TABLE IF NOT EXISTS messages (
  principal TEXT NOT NULL,
  message_id TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  intent_digest CHAR(64) NOT NULL,
  content_digest CHAR(64) NOT NULL,
  envelope_from TEXT NOT NULL,
  header_from TEXT NOT NULL,
  header_to JSONB NOT NULL CHECK (jsonb_typeof(header_to) = 'array'),
  subject TEXT NOT NULL,
  canonical_content TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK (content_bytes BETWEEN 1 AND 8192),
  recipient_count SMALLINT NOT NULL CHECK (recipient_count BETWEEN 1 AND 8),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, message_id)
);

CREATE TABLE IF NOT EXISTS mutation_receipts (
  principal TEXT NOT NULL,
  request_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  intent_digest CHAR(64) NOT NULL,
  entity_id TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, request_key, operation)
);

CREATE TABLE IF NOT EXISTS recipient_work (
  principal TEXT NOT NULL,
  message_id TEXT NOT NULL,
  recipient_ordinal SMALLINT NOT NULL CHECK (recipient_ordinal BETWEEN 0 AND 7),
  envelope_to TEXT NOT NULL,
  address_digest CHAR(64) NOT NULL,
  domain_bucket TEXT NOT NULL CHECK (domain_bucket IN ('bucket_0', 'bucket_1', 'bucket_2', 'bucket_3')),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'leased', 'attempting', 'retry_scheduled', 'remote_accepted',
    'permanent_rejected', 'suppressed', 'dead_lettered', 'unknown_after_io'
  )),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  first_queued_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  next_attempt_at TIMESTAMPTZ,
  leased_from_state TEXT CHECK (leased_from_state IN ('queued', 'retry_scheduled')),
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_owner TEXT,
  lease_assignment_generation BIGINT,
  lease_deadline TIMESTAMPTZ,
  current_attempt_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, message_id, recipient_ordinal),
  UNIQUE (principal, message_id, address_digest),
  FOREIGN KEY (principal, message_id) REFERENCES messages (principal, message_id) ON DELETE RESTRICT,
  CHECK (
    (state IN ('leased', 'attempting') AND lease_owner IS NOT NULL AND lease_deadline IS NOT NULL
      AND lease_assignment_generation IS NOT NULL AND leased_from_state IS NOT NULL)
    OR
    (state NOT IN ('leased', 'attempting') AND lease_owner IS NULL AND lease_deadline IS NULL
      AND lease_assignment_generation IS NULL AND leased_from_state IS NULL AND current_attempt_id IS NULL)
  ),
  CHECK (
    (state IN ('queued', 'retry_scheduled') AND next_attempt_at IS NOT NULL)
    OR
    (state NOT IN ('queued', 'retry_scheduled') AND next_attempt_at IS NULL)
  ),
  CHECK ((state = 'attempting' AND current_attempt_id IS NOT NULL) OR (state <> 'attempting'))
);

CREATE INDEX IF NOT EXISTS recipient_due_idx
  ON recipient_work (domain_bucket, next_attempt_at, first_queued_at, message_id, recipient_ordinal)
  WHERE state IN ('queued', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS recipient_expired_lease_idx
  ON recipient_work (domain_bucket, lease_deadline)
  WHERE state IN ('leased', 'attempting');

CREATE TABLE IF NOT EXISTS worker_assignments (
  domain_bucket TEXT PRIMARY KEY CHECK (domain_bucket IN ('bucket_0', 'bucket_1', 'bucket_2', 'bucket_3')),
  generation BIGINT NOT NULL CHECK (generation >= 1),
  worker_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  message_id TEXT NOT NULL,
  recipient_ordinal SMALLINT NOT NULL,
  attempt_number SMALLINT NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  worker_id TEXT NOT NULL,
  assignment_generation BIGINT NOT NULL CHECK (assignment_generation >= 1),
  lease_generation BIGINT NOT NULL CHECK (lease_generation >= 1),
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'io_started', 'remote_accepted', 'transient_failure', 'permanent_failure',
    'network_failure', 'abandoned_before_io', 'unknown_after_io'
  )),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  io_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_stage TEXT CHECK (last_stage IN ('connect', 'greeting', 'ehlo', 'mail', 'rcpt', 'data', 'final')),
  greeting_code SMALLINT,
  ehlo_code SMALLINT,
  mail_code SMALLINT,
  rcpt_code SMALLINT,
  data_code SMALLINT,
  final_code SMALLINT,
  enhanced_status TEXT,
  completion_digest CHAR(64),
  completion_result JSONB,
  UNIQUE (principal, message_id, recipient_ordinal, attempt_number),
  FOREIGN KEY (principal, message_id, recipient_ordinal)
    REFERENCES recipient_work (principal, message_id, recipient_ordinal) ON DELETE RESTRICT,
  CHECK (
    (state IN ('prepared', 'abandoned_before_io') AND io_started_at IS NULL)
    OR
    (state NOT IN ('prepared', 'abandoned_before_io') AND io_started_at IS NOT NULL)
  ),
  CHECK (
    (state IN ('prepared', 'io_started') AND completed_at IS NULL AND completion_digest IS NULL AND completion_result IS NULL)
    OR
    (state NOT IN ('prepared', 'io_started') AND completed_at IS NOT NULL AND completion_digest IS NOT NULL
      AND completion_result IS NOT NULL)
  )
);

ALTER TABLE recipient_work
  DROP CONSTRAINT IF EXISTS recipient_work_current_attempt_fk;

ALTER TABLE recipient_work
  ADD CONSTRAINT recipient_work_current_attempt_fk
  FOREIGN KEY (current_attempt_id) REFERENCES attempts (attempt_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS suppressions (
  principal TEXT NOT NULL,
  address_digest CHAR(64) NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  active BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, address_digest)
);

CREATE TABLE IF NOT EXISTS status_queries (
  principal TEXT NOT NULL,
  query_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  intent_digest CHAR(64) NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (principal, query_id),
  FOREIGN KEY (principal, message_id) REFERENCES messages (principal, message_id) ON DELETE RESTRICT
);
