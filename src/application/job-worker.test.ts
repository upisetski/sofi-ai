import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrations.js';
import { ConversationWorker } from './job-worker.js';
import { acceptViberCallback } from './viber-event-persistence.js';

const databaseUrl = process.env.DATABASE_URL;
let db: Db | undefined;

const user = {
  id: 'user-1',
  language: 'be',
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
    'TRUNCATE jobs, messages, conversation_events, conversations, users RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await db?.end();
});

describe.skipIf(!databaseUrl)('conversation worker', () => {
  it('waits for ten seconds after the latest message before sending one response', async () => {
    const firstReceivedAt = new Date(Date.now() - 15_000);
    const secondReceivedAt = new Date(Date.now() - 5_000);

    const first = await acceptViberCallback(
      db!,
      message(1000, 'token-1', 'first'),
      firstReceivedAt,
      0,
      10_000,
    );
    await acceptViberCallback(
      db!,
      message(1100, 'token-2', 'second'),
      secondReceivedAt,
      0,
      10_000,
    );

    const onTextBurstComplete = vi.fn().mockResolvedValue(undefined);
    const worker = new ConversationWorker(db!, { onTextBurstComplete });

    expect(await worker.runOnce()).toBe(false);
    expect(onTextBurstComplete).not.toHaveBeenCalled();

    await db!.query(
      'UPDATE jobs SET available_at = NOW() - INTERVAL \'1 second\' WHERE conversation_id = $1',
      [first.conversationId],
    );

    expect(await worker.runOnce()).toBe(true);
    expect(onTextBurstComplete).toHaveBeenCalledTimes(1);
    expect(onTextBurstComplete).toHaveBeenCalledWith({
      userId: user.id,
      language: 'be',
      messages: ['first', 'second'],
    });

    const job = await db!.query<{ status: string }>(
      'SELECT status FROM jobs WHERE conversation_id = $1',
      [first.conversationId],
    );
    expect(job.rows).toEqual([{ status: 'completed' }]);
  });
});
