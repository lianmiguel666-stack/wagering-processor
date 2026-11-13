/**
 * Initial schema. Kept as plain SQL strings so that the MikroORM migration
 * class and the schema tests execute exactly the same statements.
 *
 * Every invariant from the challenge that CAN be expressed in the database
 * is expressed here; application code is a second line of defence.
 */
export const UP_0001 = /* sql */ `
-- ---------------------------------------------------------------------------
-- wallets
-- ---------------------------------------------------------------------------
CREATE TABLE wallets (
  id          uuid          PRIMARY KEY,
  player_id   uuid          NOT NULL,
  currency    char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance     numeric(20,2) NOT NULL CHECK (balance >= 0),          -- never negative
  version     integer       NOT NULL CHECK (version >= 1),
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,
  CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency) -- at most one wallet per player+currency
);

-- ---------------------------------------------------------------------------
-- wager_transactions
-- ---------------------------------------------------------------------------
CREATE TABLE wager_transactions (
  id                                 uuid          PRIMARY KEY,
  provider_id                        varchar(128)  NOT NULL,
  external_transaction_id            varchar(128)  NOT NULL,
  idempotency_key                    varchar(255)  NOT NULL,
  payload_hash                       char(64)      NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  wallet_id                          uuid          NOT NULL REFERENCES wallets(id),
  player_id                          uuid          NOT NULL,
  round_id                           varchar(128)  NOT NULL,
  game_id                            varchar(128)  NOT NULL,
  kind                               varchar(16)   NOT NULL
    CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                             numeric(20,2) NOT NULL CHECK (amount >= 0),
  currency                           char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference_external_transaction_id  varchar(128),
  reference_transaction_id           uuid          REFERENCES wager_transactions(id),
  status                             varchar(20)   NOT NULL
    CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                       varchar(64),
  result_balance                     numeric(20,2) CHECK (result_balance >= 0),
  reference_attempts                 integer       NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
  next_retry_at                      timestamptz,
  correlation_id                     varchar(128),
  created_at                         timestamptz   NOT NULL,
  processed_at                       timestamptz,
  updated_at                         timestamptz   NOT NULL,

  CONSTRAINT uq_wager_tx_idempotency_key   UNIQUE (idempotency_key),
  CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),

  -- REFUND and ROLLBACK must carry a reference; BET and OPENING never do.
  CONSTRAINT ck_wager_tx_reference_required CHECK (
    (kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
    OR (kind IN ('BET','OPENING') AND reference_external_transaction_id IS NULL)
    OR kind IN ('WIN','LOSS')
  ),
  -- Only LOSS may carry a zero amount.
  CONSTRAINT ck_wager_tx_positive_amount CHECK (kind = 'LOSS' OR amount > 0),
  -- OPENING is internal and reserved to the "internal" provider.
  CONSTRAINT ck_wager_tx_opening_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
  -- Status coherence.
  CONSTRAINT ck_wager_tx_failure_code CHECK (
    (status IN ('REJECTED','FAILED') AND failure_code IS NOT NULL)
    OR (status NOT IN ('REJECTED','FAILED') AND failure_code IS NULL)
  ),
  CONSTRAINT ck_wager_tx_processed_at CHECK (
    (status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)
  ),
  CONSTRAINT ck_wager_tx_pending_reference CHECK (
    (status = 'PENDING_REFERENCE') = (next_retry_at IS NOT NULL)
  )
);

-- A reference can be reverted (REFUND or ROLLBACK) at most once.
CREATE UNIQUE INDEX uq_wager_tx_single_reversal
  ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';

-- Pending-reference worker scan and dependent resolution.
CREATE INDEX ix_wager_tx_pending_due
  ON wager_transactions (next_retry_at)
  WHERE status = 'PENDING_REFERENCE';
CREATE INDEX ix_wager_tx_pending_by_reference
  ON wager_transactions (provider_id, reference_external_transaction_id, wallet_id)
  WHERE status = 'PENDING_REFERENCE';
CREATE INDEX ix_wager_tx_wallet ON wager_transactions (wallet_id, created_at);

-- Terminal states are final; identity/business columns are immutable; no deletes.
CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager_transactions rows cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'transaction % is terminal (%) and cannot change', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
      NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
      NEW.reference_external_transaction_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
      OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
      OLD.reference_external_transaction_id, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable columns of transaction % cannot change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER trg_wager_transactions_guard
  BEFORE UPDATE OR DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard();

-- ---------------------------------------------------------------------------
-- wallet_ledger_entries (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE wallet_ledger_entries (
  id              uuid          PRIMARY KEY,
  sequence        bigserial     NOT NULL,
  wallet_id       uuid          NOT NULL REFERENCES wallets(id),
  transaction_id  uuid          NOT NULL REFERENCES wager_transactions(id),
  direction       varchar(6)    NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount          numeric(20,2) NOT NULL CHECK (amount > 0),
  currency        char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_before  numeric(20,2) NOT NULL CHECK (balance_before >= 0),
  balance_after   numeric(20,2) NOT NULL CHECK (balance_after >= 0),
  wallet_version  integer       NOT NULL CHECK (wallet_version >= 1),
  created_at      timestamptz   NOT NULL,

  CONSTRAINT uq_ledger_sequence UNIQUE (sequence),
  -- One financial transaction produces at most one entry per wallet.
  CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
  -- One entry per wallet version: two writers can never both "win" a version.
  CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
  -- Arithmetic of the entry itself.
  CONSTRAINT ck_ledger_balanced CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount)
    OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
  )
);
CREATE INDEX ix_ledger_wallet_sequence ON wallet_ledger_entries (wallet_id, sequence);

-- Chain integrity: each entry continues exactly where the previous one ended,
-- and its currency matches the wallet and the transaction.
CREATE FUNCTION wallet_ledger_entries_chain() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  prev record;
  w record;
  t record;
BEGIN
  SELECT currency INTO w FROM wallets WHERE id = NEW.wallet_id;
  SELECT wallet_id, amount, currency INTO t FROM wager_transactions WHERE id = NEW.transaction_id;
  IF w.currency <> NEW.currency OR t.currency <> NEW.currency THEN
    RAISE EXCEPTION 'ledger currency mismatch for wallet %', NEW.wallet_id USING ERRCODE = 'check_violation';
  END IF;
  IF t.wallet_id <> NEW.wallet_id OR t.amount <> NEW.amount THEN
    RAISE EXCEPTION 'ledger entry does not match its transaction %', NEW.transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT wallet_version, balance_after INTO prev
    FROM wallet_ledger_entries
   WHERE wallet_id = NEW.wallet_id
   ORDER BY wallet_version DESC
   LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.balance_before <> 0 THEN
      RAISE EXCEPTION 'first ledger entry of wallet % must start at 0', NEW.wallet_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF prev.wallet_version <> NEW.wallet_version - 1 OR prev.balance_after <> NEW.balance_before THEN
    RAISE EXCEPTION 'ledger chain broken for wallet % at version %', NEW.wallet_id, NEW.wallet_version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER trg_ledger_chain
  BEFORE INSERT ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_chain();

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE TRIGGER trg_ledger_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER trg_ledger_no_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Balance ⇔ ledger: at COMMIT, every wallet whose balance/version changed
-- must have the ledger entry for exactly that version and balance. A wallet
-- can therefore never change balance without a ledger line, nor skip one.
CREATE FUNCTION wallets_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  current_row record;
BEGIN
  -- Deferred trigger: re-read the row as it is at commit time.
  SELECT balance, version INTO current_row FROM wallets WHERE id = NEW.id;
  IF current_row.version = 1 AND current_row.balance = 0 THEN
    RETURN NULL; -- wallet opened with zero balance: no ledger yet
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM wallet_ledger_entries e
     WHERE e.wallet_id = NEW.id
       AND e.wallet_version = current_row.version
       AND e.balance_after = current_row.balance
  ) THEN
    RAISE EXCEPTION 'wallet % (version %, balance %) has no matching ledger entry',
      NEW.id, current_row.version, current_row.balance USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER trg_wallets_ledger_consistency
  AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION wallets_ledger_consistency();

-- Wallet identity never changes; version only moves forward together with balance.
CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable wallet columns cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'wallet balance change must increment version by exactly 1'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'wallet version may only change with the balance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER trg_wallets_guard
  BEFORE UPDATE OR DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION wallets_guard();

-- ---------------------------------------------------------------------------
-- inbox_messages
-- ---------------------------------------------------------------------------
CREATE TABLE inbox_messages (
  consumer_name  varchar(128) NOT NULL,
  message_id     varchar(255) NOT NULL,
  payload_hash   char(64)     NOT NULL,
  received_at    timestamptz  NOT NULL,
  processed_at   timestamptz,
  CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
);

-- ---------------------------------------------------------------------------
-- outbox_messages
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_messages (
  id               uuid         PRIMARY KEY,              -- = eventId
  aggregate_id     uuid         NOT NULL,
  event_type       varchar(128) NOT NULL,
  payload          jsonb        NOT NULL,
  occurred_at      timestamptz  NOT NULL,
  attempts         integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz,
  published_at     timestamptz,
  locked_by        varchar(128),
  locked_until     timestamptz,
  last_error       varchar(500),
  CONSTRAINT ck_outbox_published CHECK (published_at IS NULL OR next_attempt_at IS NULL)
);
CREATE INDEX ix_outbox_due
  ON outbox_messages (next_attempt_at, occurred_at)
  WHERE published_at IS NULL;

CREATE FUNCTION outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'published outbox message % cannot be re-opened', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
     IS DISTINCT FROM (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
    RAISE EXCEPTION 'outbox event % is immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER trg_outbox_guard
  BEFORE UPDATE ON outbox_messages
  FOR EACH ROW EXECUTE FUNCTION outbox_guard();
`;

export const DOWN_0001 = /* sql */ `
DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS inbox_messages;
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;
DROP FUNCTION IF EXISTS outbox_guard();
DROP FUNCTION IF EXISTS wallets_guard();
DROP FUNCTION IF EXISTS wallets_ledger_consistency();
DROP FUNCTION IF EXISTS reject_mutation();
DROP FUNCTION IF EXISTS wallet_ledger_entries_chain();
DROP FUNCTION IF EXISTS wager_transactions_guard();
`;
