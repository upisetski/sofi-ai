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

-- Expired message content must not cascade-delete deduplication metadata.
ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_event_id_fkey;

ALTER TABLE messages
  ADD CONSTRAINT messages_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES conversation_events(id) ON DELETE SET NULL;

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

export async function migrate(db: Pool): Promise<void> {
  await db.query(migration);
}
