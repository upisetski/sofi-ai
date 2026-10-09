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
import { createOpenRouterClient } from '../integrations/openrouter/client.js';
import { createAiRouter } from './ai-router.js';
import { ConversationWorker } from './job-worker.js';
import { handleTextBurstComplete } from './text-burst-handler.js';
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
      "UPDATE jobs SET available_at = NOW() - INTERVAL '1 second' WHERE conversation_id = $1",
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

  it('runs one AI generation for a ready debounce job and sends one Viber response', async () => {
    const receivedAt = new Date(Date.now() - 15_000);
    await acceptViberCallback(
      db!,
      message(2000, 'token-ai-1', 'first question'),
      receivedAt,
      0,
      10_000,
    );
    await acceptViberCallback(
      db!,
      message(2100, 'token-ai-2', 'more detail'),
      receivedAt,
      0,
      10_000,
    );

    const openRouterFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: 'Generated response' } },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const aiRouter = createAiRouter(
      {
        models: { cheap_text: 'google/gemma-3-4b-it' },
        maxOutputTokens: 512,
        requestTimeoutMs: 30_000,
      },
      createOpenRouterClient({
        apiKey: 'test-openrouter-key',
        fetchImpl: openRouterFetch,
      }),
      { info: vi.fn(), error: vi.fn() },
    );
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);
    const worker = new ConversationWorker(db!, {
      onTextBurstComplete: (input) =>
        handleTextBurstComplete({ sendTextMessage }, aiRouter, input),
    });

    expect(await worker.runOnce()).toBe(true);
    expect(openRouterFetch).toHaveBeenCalledTimes(1);
    const request = JSON.parse(
      String(openRouterFetch.mock.calls[0]?.[1]?.body),
    ) as { messages: Array<{ role: string; content: string }> };
    expect(request.messages[0]?.content).toContain('Belarusian');
    expect(request.messages.slice(1)).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'user', content: 'more detail' },
    ]);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith({
      receiver: user.id,
      senderName: 'Сафі - AI-памочніца',
      text: 'Generated response',
    });
  });
});
