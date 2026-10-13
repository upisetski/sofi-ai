import type { PoolClient } from 'pg';

import { withTransaction, type Db } from '../db/client.js';
import type { ViberCallback } from '../integrations/viber/schemas.js';
import { isContextResetCommand } from './conversation-commands.js';

const provider = 'viber';
const jobType = 'process_conversation';
const defaultMessageDebounceMs = 5000;

export interface AcceptedEvent {
  eventId: string;
  conversationId: string;
  duplicate: boolean;
}

function getUser(callback: ViberCallback): {
  id: string;
  language?: string;
} | null {
  if (callback.event === 'message') {
    return callback.sender.language === undefined
      ? { id: callback.sender.id }
      : { id: callback.sender.id, language: callback.sender.language };
  }

  if (
    callback.event === 'conversation_started' ||
    callback.event === 'subscribed'
  ) {
    return callback.user.language === undefined
      ? { id: callback.user.id }
      : { id: callback.user.id, language: callback.user.language };
  }

  if (callback.event === 'unsubscribed') {
    return { id: callback.user_id };
  }

  return null;
}

function getEventType(callback: ViberCallback): string {
  switch (callback.event) {
    case 'conversation_started':
    case 'subscribed':
    case 'unsubscribed':
    case 'message':
      return callback.event;
    default:
      throw new Error(
        'Unsupported Viber event for persistence: ' + callback.event,
      );
  }
}

function getProviderEventId(callback: ViberCallback): string {
  if (callback.message_token === undefined) {
    throw new Error('Viber event does not have a message token');
  }

  return String(callback.message_token);
}

function isContextResetMessage(callback: ViberCallback): boolean {
  return (
    callback.event === 'message' &&
    callback.message.type === 'text' &&
    isContextResetCommand(callback.message.text)
  );
}

function isTextMessage(callback: ViberCallback): boolean {
  return (
    callback.event === 'message' &&
    callback.message.type === 'text' &&
    !isContextResetMessage(callback)
  );
}

function getAvailableAt(
  debounceTextMessage: boolean,
  receivedAt: Date,
  reorderDelayMs: number,
  messageDebounceMs: number,
): Date {
  const delayMs = debounceTextMessage
    ? Math.max(reorderDelayMs, messageDebounceMs)
    : reorderDelayMs;

  return new Date(receivedAt.getTime() + delayMs);
}

export async function acceptViberCallback(
  db: Db,
  callback: ViberCallback,
  receivedAt = new Date(),
  reorderDelayMs = 1000,
  messageDebounceMs = defaultMessageDebounceMs,
): Promise<AcceptedEvent> {
  const user = getUser(callback);
  if (!user) {
    throw new Error('Unsupported Viber callback');
  }

  return withTransaction(db, async (client) => {
    const userResult = await client.query<{ id: string }>(
      `
        INSERT INTO users (provider, provider_user_id)
        VALUES ($1, $2)
        ON CONFLICT (provider, provider_user_id)
        DO UPDATE SET updated_at = NOW()
        RETURNING id
      `,
      [provider, user.id],
    );

    const userId = userResult.rows[0]?.id;
    if (!userId) throw new Error('Failed to resolve Viber user');

    const conversationResult = await client.query<{
      id: string;
      last_event_position: string;
      last_processed_position: string;
    }>(
      `
        INSERT INTO conversations (user_id, locale)
        VALUES ($1, $2)
        ON CONFLICT (user_id)
        DO UPDATE SET
          locale = COALESCE(EXCLUDED.locale, conversations.locale),
          updated_at = NOW()
        RETURNING id, last_event_position, last_processed_position
      `,
      [userId, user.language ?? null],
    );

    const conversation = conversationResult.rows[0];
    if (!conversation) throw new Error('Failed to resolve conversation');

    const eventId = getProviderEventId(callback);
    const eventType = getEventType(callback);

    const existing = await client.query<{ id: string }>(
      `
        SELECT id
        FROM conversation_events
        WHERE provider = $1 AND provider_event_id = $2
        FOR UPDATE
      `,
      [provider, eventId],
    );

    if (existing.rows[0]) {
      return {
        eventId: existing.rows[0].id,
        conversationId: conversation.id,
        duplicate: true,
      };
    }

    const contextResetMessage = isContextResetMessage(callback);
    const textMessage = isTextMessage(callback);

    const nextPosition = Number(conversation.last_event_position) + 1;
    const eventResult = await client.query<{ id: string }>(
      `
        INSERT INTO conversation_events (
          conversation_id,
          provider,
          event_type,
          provider_event_id,
          position,
          occurred_at,
          received_at,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, TO_TIMESTAMP($6 / 1000.0), $7, $8::jsonb)
        RETURNING id
      `,
      [
        conversation.id,
        provider,
        eventType,
        eventId,
        nextPosition,
        callback.timestamp,
        receivedAt,
        JSON.stringify(callback),
      ],
    );

    const insertedEvent = eventResult.rows[0];
    if (!insertedEvent) throw new Error('Failed to persist Viber event');

    await client.query(
      `
        UPDATE conversations
        SET last_event_position = $1, updated_at = NOW()
        WHERE id = $2
      `,
      [nextPosition, conversation.id],
    );

    await wakeJob(
      client,
      conversation.id,
      getAvailableAt(
        textMessage,
        receivedAt,
        reorderDelayMs,
        messageDebounceMs,
      ),
      contextResetMessage,
    );

    return {
      eventId: insertedEvent.id,
      conversationId: conversation.id,
      duplicate: false,
    };
  });
}

async function wakeJob(
  client: PoolClient,
  conversationId: string,
  availableAt: Date,
  bypassDebounce: boolean,
): Promise<void> {
  await client.query(
    `
      INSERT INTO jobs (
        type, conversation_id, status, available_at
      )
      VALUES ($1, $2, 'pending', $3)
      ON CONFLICT (type, conversation_id)
      DO UPDATE SET
        status = CASE
          WHEN jobs.status IN ('completed', 'failed') THEN 'pending'
          ELSE jobs.status
        END,
        available_at = CASE
          WHEN $4 THEN LEAST(jobs.available_at, EXCLUDED.available_at)
          ELSE GREATEST(jobs.available_at, EXCLUDED.available_at)
        END,
        completed_at = CASE
          WHEN jobs.status IN ('completed', 'failed') THEN NULL
          ELSE jobs.completed_at
        END,
        last_error = CASE
          WHEN jobs.status IN ('completed', 'failed') THEN NULL
          ELSE jobs.last_error
        END
    `,
    [jobType, conversationId, availableAt, bypassDebounce],
  );
}
