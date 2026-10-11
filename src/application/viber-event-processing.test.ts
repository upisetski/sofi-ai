import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrations.js';
import { processConversation } from './conversation-processor.js';
import { acceptViberCallback } from './viber-event-persistence.js';

const databaseUrl = process.env.DATABASE_URL;
let db: Db | undefined;

const user = {
  id: 'user-1',
  language: 'en',
};

function message(timestamp: number, token: string, text: string) {
  return {
    event: 'message' as const,
    timestamp,
    message_token: token,
    sender: user,
    message: { type: 'text' as const, text },
  };
}

beforeAll(async () => {
  if (!databaseUrl) return;
  db = createDb(databaseUrl);
  await migrate(db);
});

beforeEach(async () => {
  if (!db) return;
  await db.query(
    'TRUNCATE jobs, viber_delivery_callbacks, conversation_turns, messages, conversation_events, conversations, users RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await db?.end();
});

describe.skipIf(!databaseUrl)('Viber event processing', () => {
  it('processes events by provider timestamp, not acceptance order', async () => {
    const first = await acceptViberCallback(
      db!,
      message(2000, 'token-2', 'second'),
      new Date('2026-01-01T00:00:02Z'),
      0,
      0,
    );
    await acceptViberCallback(
      db!,
      message(1000, 'token-1', 'first'),
      new Date('2026-01-01T00:00:03Z'),
      0,
      0,
    );

    const processed = await processConversation(db!, first.conversationId);

    expect(processed.events.map((event) => event.occurredAt.getTime())).toEqual([
      1000,
      2000,
    ]);

    const messages = await db!.query(
      'SELECT content FROM messages ORDER BY id ASC',
    );
    expect(messages.rows).toEqual([
      { content: 'first' },
      { content: 'second' },
    ]);
  });

  it('uses event id as deterministic tie-breaker for equal timestamps', async () => {
    const first = await acceptViberCallback(
      db!,
      message(1000, 'token-1', 'first'),
      new Date('2026-01-01T00:00:01Z'),
      0,
      0,
    );
    const second = await acceptViberCallback(
      db!,
      message(1000, 'token-2', 'second'),
      new Date('2026-01-01T00:00:02Z'),
      0,
      0,
    );

    const processed = await processConversation(db!, first.conversationId);
    expect(processed.events.map((event) => event.id)).toEqual([
      first.eventId,
      second.eventId,
    ]);
  });

  it('updates subscription state only when lifecycle events are processed', async () => {
    const started = await acceptViberCallback(
      db!,
      {
        event: 'conversation_started',
        timestamp: 1000,
        message_token: 'start',
        type: 'open',
        user,
        subscribed: false,
      },
      new Date('2026-01-01T00:00:01Z'),
      0,
      0,
    );

    await acceptViberCallback(
      db!,
      {
        event: 'subscribed',
        timestamp: 2000,
        message_token: 'subscribe',
        user,
      },
      new Date('2026-01-01T00:00:02Z'),
      0,
      0,
    );

    await acceptViberCallback(
      db!,
      {
        event: 'unsubscribed',
        timestamp: 3000,
        message_token: 'unsubscribe',
        user_id: user.id,
      },
      new Date('2026-01-01T00:00:03Z'),
      0,
      0,
    );

    const before = await db!.query(
      'SELECT subscription_status FROM conversations WHERE id = $1',
      [started.conversationId],
    );
    expect(before.rows).toEqual([{ subscription_status: 'unknown' }]);

    await processConversation(db!, started.conversationId);

    const after = await db!.query(
      'SELECT subscription_status, last_processed_position FROM conversations WHERE id = $1',
      [started.conversationId],
    );
    expect(after.rows).toEqual([
      { subscription_status: 'unsubscribed', last_processed_position: '3' },
    ]);
  });

  it('serializes concurrent processing of one conversation', async () => {
    const accepted = await acceptViberCallback(
      db!,
      message(1000, 'token-1', 'hello'),
      new Date(),
      0,
      0,
    );

    const [first, second] = await Promise.all([
      processConversation(db!, accepted.conversationId),
      processConversation(db!, accepted.conversationId),
    ]);

    expect(first.events.length + second.events.length).toBe(1);

    const messages = await db!.query(
      'SELECT COUNT(*)::int AS count FROM messages',
    );
    expect(messages.rows[0]?.count).toBe(1);
  });

  it('does not create duplicate events for duplicate delivery', async () => {
    const accepted = await acceptViberCallback(
      db!,
      message(1000, 'token-1', 'hello'),
      new Date(),
      0,
      10000,
    );
    const duplicate = await acceptViberCallback(
      db!,
      message(1000, 'token-1', 'hello'),
      new Date(),
      0,
      10000,
    );

    expect(duplicate.duplicate).toBe(true);

    await processConversation(db!, accepted.conversationId);

    const events = await db!.query(
      'SELECT COUNT(*)::int AS count FROM conversation_events',
    );
    const messages = await db!.query(
      'SELECT COUNT(*)::int AS count FROM messages',
    );
    expect(events.rows[0]?.count).toBe(1);
    expect(messages.rows[0]?.count).toBe(1);
  });

  it('debounces rapid messages and starts a new response window after processing', async () => {
    const firstReceivedAt = new Date('2026-01-01T00:00:00Z');
    const secondReceivedAt = new Date('2026-01-01T00:00:00.500Z');

    const first = await acceptViberCallback(
      db!,
      message(1000, 'token-1', 'first'),
      firstReceivedAt,
      1000,
      10000,
    );

    await acceptViberCallback(
      db!,
      message(1100, 'token-2', 'second'),
      secondReceivedAt,
      1000,
      10000,
    );

    const job = await db!.query<{ available_at: Date }>(
      'SELECT available_at FROM jobs WHERE conversation_id = $1',
      [first.conversationId],
    );
    expect(job.rows[0]?.available_at.toISOString()).toBe(
      '2026-01-01T00:00:10.500Z',
    );

    await processConversation(db!, first.conversationId);

    await acceptViberCallback(
      db!,
      message(1200, 'token-3', 'third'),
      new Date('2026-01-01T00:00:15Z'),
      1000,
      10000,
    );

    await processConversation(db!, first.conversationId);

    const messages = await db!.query(
      'SELECT content FROM messages ORDER BY id ASC',
    );
    expect(messages.rows).toEqual([
      { content: 'first' },
      { content: 'second' },
      { content: 'third' },
    ]);
  });

  it('does not apply text debounce to non-text messages', async () => {
    const accepted = await acceptViberCallback(
      db!,
      {
        event: 'message',
        timestamp: 1000,
        message_token: 'picture-1',
        sender: user,
        message: {
          type: 'picture',
          text: 'caption',
          media: 'https://example.com/image.jpg',
        },
      },
      new Date('2026-01-01T00:00:00Z'),
      1000,
      10000,
    );

    const job = await db!.query<{ available_at: Date }>(
      'SELECT available_at FROM jobs WHERE conversation_id = $1',
      [accepted.conversationId],
    );
    expect(job.rows[0]?.available_at.toISOString()).toBe(
      '2026-01-01T00:00:01.000Z',
    );
  });

  it('keeps text messages debounced when a lifecycle event is pending', async () => {
    const started = await acceptViberCallback(
      db!,
      {
        event: 'conversation_started',
        timestamp: 1000,
        message_token: 'start',
        type: 'open',
        user,
        subscribed: false,
      },
      new Date('2026-01-01T00:00:00Z'),
      1000,
      10000,
    );

    const messageEvent = await acceptViberCallback(
      db!,
      message(1100, 'token-1', 'hello'),
      new Date('2026-01-01T00:00:00.200Z'),
      1000,
      10000,
    );

    expect(messageEvent.conversationId).toBe(started.conversationId);
  });
});
