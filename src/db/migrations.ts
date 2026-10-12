import type { Pool } from 'pg';

const migration = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  subscription_status TEXT NOT NULL DEFAULT 'unknown',
  locale TEXT,
  last_event_position BIGINT NOT NULL DEFAULT 0,
  last_processed_position BIGINT NOT NULL DEFAULT 0,
  processing_state TEXT NOT NULL DEFAULT 'idle',
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS conversation_events (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  position BIGINT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_event_id),
  UNIQUE (conversation_id, position)
);

CREATE INDEX IF NOT EXISTS conversation_events_order_idx
  ON conversation_events (conversation_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  event_id BIGINT NOT NULL REFERENCES conversation_events(id) ON DELETE CASCADE,
  position BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS messages_conversation_position_idx
  ON messages (conversation_id, position);

CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  available_at TIMESTAMPTZ NOT NULL,
  locked_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (type, conversation_id)
);

CREATE INDEX IF NOT EXISTS jobs_ready_idx
  ON jobs (status, available_at);

-- Forward-only WP1 migration. Existing inbound rows and provider event IDs remain intact.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS context_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE messages
  ALTER COLUMN event_id DROP NOT NULL;

-- Keep inbound-event deduplication metadata when message content expires.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'messages'::regclass
      AND conname = 'messages_event_id_fkey'
      AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE messages DROP CONSTRAINT messages_event_id_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'messages'::regclass
      AND conname = 'messages_event_id_fkey'
      AND confdeltype = 'n'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_event_id_fkey
      FOREIGN KEY (event_id) REFERENCES conversation_events(id) ON DELETE SET NULL;
  END IF;
END;
$migration$;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS context_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS conversation_turns (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_kind TEXT NOT NULL DEFAULT 'chat'
    CHECK (turn_kind IN ('chat', 'reset')),
  start_position BIGINT NOT NULL,
  end_position BIGINT NOT NULL,
  context_version INTEGER NOT NULL DEFAULT 0,
  generation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (generation_status IN ('pending', 'generating', 'generated', 'retryable_failure', 'failed')),
  delivery_status TEXT NOT NULL DEFAULT 'not_ready'
    CHECK (delivery_status IN ('not_ready', 'pending', 'sending', 'retryable_failure', 'accepted', 'delivered', 'terminal_failure')),
  generation_attempts INTEGER NOT NULL DEFAULT 0,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failure_stage TEXT CHECK (failure_stage IN ('generation', 'delivery')),
  last_error_category TEXT,
  assistant_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  viber_message_token TEXT,
  generated_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, start_position, end_position, turn_kind)
);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS turn_id BIGINT
  REFERENCES conversation_turns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_conversation_context_order_idx
  ON messages (conversation_id, context_version, id);

CREATE INDEX IF NOT EXISTS messages_turn_idx
  ON messages (turn_id, id);

CREATE INDEX IF NOT EXISTS conversation_turns_active_idx
  ON conversation_turns (conversation_id, id)
  WHERE delivery_status IN ('not_ready', 'pending', 'sending', 'retryable_failure');

CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_assistant_message_idx
  ON conversation_turns (assistant_message_id)
  WHERE assistant_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_viber_token_idx
  ON conversation_turns (viber_message_token)
  WHERE viber_message_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS viber_delivery_callbacks (
  message_token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('delivered', 'seen', 'failed')),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS viber_delivery_callbacks_retention_idx
  ON viber_delivery_callbacks (received_at);
`;

const usageMigration = `
CREATE TABLE IF NOT EXISTS usage_budget_mutex (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);
INSERT INTO usage_budget_mutex (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_usage_attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id BIGINT NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  route TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('reserved', 'in_flight', 'success', 'failure')),
  failure_category TEXT,
  prompt_estimated_tokens BIGINT CHECK (prompt_estimated_tokens IS NULL OR prompt_estimated_tokens >= 0),
  prompt_tokens BIGINT CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens BIGINT CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  total_tokens BIGINT CHECK (total_tokens IS NULL OR total_tokens >= 0),
  provider_generation_id TEXT,
  provider_cost_usd NUMERIC(20, 12) CHECK (provider_cost_usd IS NULL OR provider_cost_usd >= 0),
  estimated_cost_usd NUMERIC(20, 12) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  cost_kind TEXT NOT NULL CHECK (cost_kind IN ('actual', 'estimated', 'unknown')),
  cost_provenance TEXT NOT NULL,
  reserved_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  initial_reserved_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (initial_reserved_usd >= 0),
  reservation_state TEXT NOT NULL CHECK (reservation_state IN ('reserved', 'in_flight', 'settled', 'released', 'uncertain')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (turn_id, attempt_number)
);

ALTER TABLE ai_usage_attempts
  ADD COLUMN IF NOT EXISTS initial_reserved_usd NUMERIC(20, 12) NOT NULL DEFAULT 0;
UPDATE ai_usage_attempts SET initial_reserved_usd = reserved_usd WHERE initial_reserved_usd = 0 AND reserved_usd > 0;

CREATE INDEX IF NOT EXISTS ai_usage_attempts_user_started_idx
  ON ai_usage_attempts (user_id, started_at);
CREATE INDEX IF NOT EXISTS ai_usage_attempts_started_idx
  ON ai_usage_attempts (started_at);
CREATE INDEX IF NOT EXISTS ai_usage_attempts_turn_idx
  ON ai_usage_attempts (turn_id, attempt_number);
`;

export async function migrate(db: Pool): Promise<void> {
  await db.query(migration);
  await db.query(usageMigration);
}
