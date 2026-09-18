import type { PoolClient } from 'pg';

import type { Db } from '../db/client.js';

const jobType = 'process_conversation';

export interface ProcessedEvent {
  id: string;
  eventType: string;
  occurredAt: Date;
  position: number;
}

export async function processConversation(
  db: Db,
  conversationId: string,
): Promise<ProcessedEvent[]> {
  return withConversationLock(db, conversationId, async (client) => {
    const conversationResult = await client.query<{
      last_processed_position: string;
    }>(
      'SELECT last_processed_position FROM conversations WHERE id = $1 FOR UPDATE',
      [conversationId],
    );
    const conversation = conversationResult.rows[0];
    if (!conversation) return [];

    const eventsResult = await client.query<{
      id: string;
      event_type: string;
      occurred_at: Date;
      position: string;
    }>(
      `
        SELECT id, event_type, occurred_at, position
        FROM conversation_events
        WHERE conversation_id = $1
          AND position > $2
        ORDER BY occurred_at ASC, id ASC
      `,
      [conversationId, conversation.last_processed_position],
    );

    const processed: ProcessedEvent[] = [];

    for (const event of eventsResult.rows) {
      processed.push({
        id: event.id,
        eventType: event.event_type,
        occurredAt: event.occurred_at,
        position: Number(event.position),
      });
      await client.query(
        `
          UPDATE conversations
          SET last_processed_position = $1,
              processing_state = 'processing',
              updated_at = NOW()
          WHERE id = $2
        `,
        [event.position, conversationId],
      );
    }

    await client.query(
      `
        UPDATE conversations
        SET processing_state = 'idle', updated_at = NOW()
        WHERE id = $1
      `,
      [conversationId],
    );

    return processed;
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

    const lockResult = await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [conversationId],
    );
    void lockResult;

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
