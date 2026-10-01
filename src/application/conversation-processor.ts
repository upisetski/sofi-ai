import type { PoolClient } from 'pg';

import type { Db } from '../db/client.js';

export interface ProcessedEvent {
  id: string;
  eventType: string;
  occurredAt: Date;
  position: number;
}

export interface ProcessedConversation {
  events: ProcessedEvent[];
  textMessages: string[];
  userId: string;
  language?: string;
}

export async function processConversation(
  db: Db,
  conversationId: string,
): Promise<ProcessedConversation> {
  return withConversationLock(db, conversationId, async (client) => {
    const conversationResult = await client.query<{
      last_processed_position: string;
      provider_user_id: string;
      locale: string | null;
    }>(
      `SELECT c.last_processed_position, u.provider_user_id, c.locale
       FROM conversations c
       JOIN users u ON u.id = c.user_id
       WHERE c.id = $1
       FOR UPDATE OF c`,
      [conversationId],
    );
    const conversation = conversationResult.rows[0];
    if (!conversation) {
      return {
        events: [],
        textMessages: [],
        userId: '',
      };
    }

    const eventsResult = await client.query<{
      id: string;
      event_type: string;
      occurred_at: Date;
      position: string;
      payload: unknown;
    }>(
      `SELECT id, event_type, occurred_at, position, payload
       FROM conversation_events
       WHERE conversation_id = $1 AND position > $2
       ORDER BY occurred_at ASC, id ASC`,
      [conversationId, conversation.last_processed_position],
    );

    const processed: ProcessedEvent[] = [];
    const textMessages: string[] = [];
    let lastProcessedPosition = Number(conversation.last_processed_position);

    for (const event of eventsResult.rows) {
      if (event.event_type === 'message') {
        const payload = event.payload as {
          message?: { type?: string; text?: string };
        };
        const text =
          payload.message?.type === 'text' ? payload.message.text : null;

        if (text !== null && text !== undefined) {
          await client.query(
            `INSERT INTO messages (conversation_id, role, content, event_id, position)
             VALUES ($1, 'user', $2, $3, $4)
             ON CONFLICT (event_id) DO NOTHING`,
            [conversationId, text, event.id, event.position],
          );
          textMessages.push(text);
        }
      } else if (event.event_type === 'subscribed') {
        await client.query(
          `UPDATE conversations
           SET subscription_status = 'subscribed', updated_at = NOW()
           WHERE id = $1`,
          [conversationId],
        );
      } else if (event.event_type === 'unsubscribed') {
        await client.query(
          `UPDATE conversations
           SET subscription_status = 'unsubscribed', updated_at = NOW()
           WHERE id = $1`,
          [conversationId],
        );
      }

      lastProcessedPosition = Math.max(
        lastProcessedPosition,
        Number(event.position),
      );

      processed.push({
        id: event.id,
        eventType: event.event_type,
        occurredAt: event.occurred_at,
        position: Number(event.position),
      });
    }

    await client.query(
      `UPDATE conversations
       SET last_processed_position = $1,
           processing_state = 'idle',
           updated_at = NOW()
       WHERE id = $2`,
      [lastProcessedPosition, conversationId],
    );

    return {
      events: processed,
      textMessages,
      userId: conversation.provider_user_id,
      language: conversation.locale ?? undefined,
    };
  });
}

async function withConversationLock<T>(
  db: Db,
  conversationId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [conversationId],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
