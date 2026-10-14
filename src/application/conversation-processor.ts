import type { PoolClient } from 'pg';

import type { Db } from '../db/client.js';
import { getContextResetConfirmation } from '../localization/index.js';
import { isContextResetCommand } from './conversation-commands.js';

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
  createdTurnIds: string[];
}

interface EventRow {
  id: string;
  event_type: string;
  occurred_at: Date;
  position: string;
  payload: unknown;
}

interface TurnSegment {
  kind: 'chat' | 'reset';
  contextVersion: number;
  eventIds: string[];
  positions: number[];
  resetEventId?: string;
  turnId?: string;
}

function getText(payloadValue: unknown): string | null {
  if (!payloadValue || typeof payloadValue !== 'object') return null;

  const payload = payloadValue as {
    message?: { type?: string; text?: unknown };
  };
  if (
    payload.message?.type !== 'text' ||
    typeof payload.message.text !== 'string'
  ) {
    return null;
  }

  return payload.message.text;
}

function makeSegments(
  events: EventRow[],
  initialContextVersion: number,
): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let contextVersion = initialContextVersion;
  let chat: TurnSegment | undefined;

  const flushChat = () => {
    if (chat) segments.push(chat);
    chat = undefined;
  };

  for (const event of events) {
    if (event.event_type !== 'message') continue;
    const text = getText(event.payload);
    if (text === null) continue;

    if (isContextResetCommand(text)) {
      flushChat();
      contextVersion += 1;
      segments.push({
        kind: 'reset',
        contextVersion,
        eventIds: [],
        positions: [Number(event.position)],
        resetEventId: event.id,
      });
      continue;
    }

    if (!chat) {
      chat = {
        kind: 'chat',
        contextVersion,
        eventIds: [],
        positions: [],
      };
    }

    chat.eventIds.push(event.id);
    chat.positions.push(Number(event.position));
  }

  flushChat();
  return segments;
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
      context_version: number;
    }>(
      `SELECT c.last_processed_position, c.context_version,
              u.provider_user_id, c.locale
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
        createdTurnIds: [],
      };
    }

    const initialLastProcessedPosition = Number(
      conversation.last_processed_position,
    );
    const eventsResult = await client.query<EventRow>(
      `SELECT id, event_type, occurred_at, position, payload
       FROM conversation_events
       WHERE conversation_id = $1 AND position > $2
       ORDER BY occurred_at ASC, id ASC`,
      [conversationId, initialLastProcessedPosition],
    );

    const segments = makeSegments(
      eventsResult.rows,
      Number(conversation.context_version),
    );
    const segmentForEvent = new Map<
      string,
      { turnId: string; contextVersion: number; kind: TurnSegment['kind'] }
    >();
    const createdTurnIds: string[] = [];

    // Persist the turn skeleton in the same transaction that advances the event cursor.
    for (const segment of segments) {
      const startPosition = Math.min(...segment.positions);
      const endPosition = Math.max(...segment.positions);
      const result = await client.query<{ id: string }>(
        `INSERT INTO conversation_turns (
           conversation_id, turn_kind, start_position, end_position,
           context_version, generation_status, delivery_status, available_at,
           generated_at
         )
         VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, NOW(),
           CASE WHEN $2 = 'reset' THEN NOW() ELSE NULL END
         )
         RETURNING id`,
        [
          conversationId,
          segment.kind,
          startPosition,
          endPosition,
          segment.contextVersion,
          segment.kind === 'reset' ? 'generated' : 'pending',
          segment.kind === 'reset' ? 'pending' : 'not_ready',
        ],
      );
      const turnId = result.rows[0]?.id;
      if (!turnId) throw new Error('Failed to create conversation turn');

      segment.turnId = turnId;
      createdTurnIds.push(turnId);
      for (const eventId of segment.eventIds) {
        segmentForEvent.set(eventId, {
          turnId,
          contextVersion: segment.contextVersion,
          kind: segment.kind,
        });
      }
      if (segment.resetEventId) {
        segmentForEvent.set(segment.resetEventId, {
          turnId,
          contextVersion: segment.contextVersion,
          kind: 'reset',
        });
      }
    }

    const processed: ProcessedEvent[] = [];
    const processedIdsBeforeCurrentEvent: string[] = [];
    const textMessages: string[] = [];
    let lastProcessedPosition = initialLastProcessedPosition;
    let latestContextVersion = Number(conversation.context_version);

    for (const event of eventsResult.rows) {
      if (event.event_type === 'message') {
        const text = getText(event.payload);

        if (text !== null && isContextResetCommand(text)) {
          const reset = segmentForEvent.get(event.id);
          if (!reset) throw new Error('Context reset turn is missing');

          latestContextVersion = reset.contextVersion;

          await client.query(
            `UPDATE conversation_events
             SET payload = jsonb_build_object('event', event_type, 'redacted', true)
             WHERE conversation_id = $1
               AND event_type = 'message'
               AND (
                 position <= $2
                 OR id = ANY($3::bigint[])
                 OR id = $4
               )`,
            [
              conversationId,
              initialLastProcessedPosition,
              processedIdsBeforeCurrentEvent,
              event.id,
            ],
          );

          await client.query(
            `UPDATE conversation_turns
             SET generation_status = 'failed',
                 delivery_status = 'terminal_failure',
                 failure_stage = 'generation',
                 last_error_category = 'context_reset',
                 updated_at = NOW()
             WHERE conversation_id = $1
               AND context_version < $2
               AND delivery_status = 'not_ready'
               AND generation_status IN ('pending', 'generating', 'retryable_failure')`,
            [conversationId, latestContextVersion],
          );

          await client.query(
            `DELETE FROM messages m
             WHERE m.conversation_id = $1
               AND m.context_version < $2
               AND (
                 m.role = 'user'
                 OR NOT EXISTS (
                   SELECT 1
                   FROM conversation_turns t
                   WHERE t.assistant_message_id = m.id
                     AND t.delivery_status IN ('pending', 'sending', 'retryable_failure')
                 )
               )`,
            [conversationId, latestContextVersion],
          );

          await client.query(
            `UPDATE conversations
             SET context_version = $2, updated_at = NOW()
             WHERE id = $1`,
            [conversationId, latestContextVersion],
          );

          console.info(
            JSON.stringify({
              event: 'conversation_context_reset',
              conversationId,
              contextVersion: latestContextVersion,
            }),
          );

          const confirmation = getContextResetConfirmation(
            conversation.locale ?? undefined,
          );
          const messageResult = await client.query<{ id: string }>(
            `INSERT INTO messages (
               conversation_id, turn_id, role, content, event_id,
               position, context_version
             )
             VALUES ($1, $2, 'assistant', $3, NULL, $4, $5)
             RETURNING id`,
            [
              conversationId,
              reset.turnId,
              confirmation.text,
              Number(event.position),
              latestContextVersion,
            ],
          );
          const assistantMessageId = messageResult.rows[0]?.id;
          if (!assistantMessageId) {
            throw new Error('Failed to persist context reset confirmation');
          }

          await client.query(
            `UPDATE conversation_turns
             SET assistant_message_id = $2, updated_at = NOW()
             WHERE id = $1`,
            [reset.turnId, assistantMessageId],
          );

          textMessages.length = 0;
        } else if (text !== null) {
          const turn = segmentForEvent.get(event.id);
          if (!turn || turn.kind !== 'chat') {
            throw new Error('Chat turn is missing for a text message');
          }

          await client.query(
            `INSERT INTO messages (
               conversation_id, turn_id, role, content, event_id,
               position, context_version
             )
             VALUES ($1, $2, 'user', $3, $4, $5, $6)
             ON CONFLICT (event_id) DO NOTHING`,
            [
              conversationId,
              turn.turnId,
              text,
              event.id,
              event.position,
              turn.contextVersion,
            ],
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
      processedIdsBeforeCurrentEvent.push(event.id);
    }

    await client.query(
      `UPDATE conversations
       SET last_processed_position = $1,
           context_version = $2,
           processing_state = 'idle',
           updated_at = NOW()
       WHERE id = $3`,
      [lastProcessedPosition, latestContextVersion, conversationId],
    );

    return {
      events: processed,
      textMessages,
      userId: conversation.provider_user_id,
      ...(conversation.locale ? { language: conversation.locale } : {}),
      createdTurnIds,
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
