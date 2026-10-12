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
import {
  type TextBurstCompleteInput,
  ConversationWorker,
} from './job-worker.js';
import { AiGenerationError } from './ai-router.js';
import {
  UsageAccountingService,
  UsageBudgetError,
} from './usage-accounting.js';
import { recordViberDeliveryCallback } from './viber-delivery-callback.js';
import { acceptViberCallback } from './viber-event-persistence.js';

const databaseUrl = process.env.DATABASE_URL;
let db: Db | undefined;

const user = {
  id: 'user-1',
  language: 'en',
};

function message(
  timestamp: number,
  token: string,
  text: string,
  userId = user.id,
  language = user.language,
) {
  return {
    event: 'message' as const,
    timestamp,
    message_token: token,
    sender: { id: userId, language },
    message: { type: 'text' as const, text },
  };
}

async function acceptText(
  text: string,
  token: string,
  userId = user.id,
  language = user.language,
) {
  return acceptViberCallback(
    db!,
    message(Date.now(), token, text, userId, language),
    new Date(Date.now() - 20_000),
    0,
    0,
  );
}

async function makeJobReady(conversationId: string): Promise<void> {
  await db!.query(
    "UPDATE jobs SET available_at = NOW() - INTERVAL '1 second' WHERE conversation_id = $1",
    [conversationId],
  );
}

async function runGeneratedAndDelivered(
  worker: ConversationWorker,
): Promise<void> {
  expect(await worker.runOnce()).toBe(true);
  expect(await worker.runOnce()).toBe(true);
}

async function runUntilIdle(worker: ConversationWorker): Promise<void> {
  for (let attempts = 0; attempts < 5; attempts += 1) {
    if (!(await worker.runOnce())) return;
  }
  throw new Error('Worker did not become idle within five runs');
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

describe.skipIf(!databaseUrl)('conversation worker', () => {
  it('preserves the ten-second debounce and sends one response for the burst', async () => {
    const firstReceivedAt = new Date(Date.now() - 15_000);
    const secondReceivedAt = new Date(Date.now() - 5_000);
    const accepted = await acceptViberCallback(
      db!,
      message(1000, 'token-debounce-1', 'first'),
      firstReceivedAt,
      0,
      10_000,
    );
    await acceptViberCallback(
      db!,
      message(1100, 'token-debounce-2', 'second'),
      secondReceivedAt,
      0,
      10_000,
    );

    const generateReply = vi.fn().mockResolvedValue('burst response');
    const sendReply = vi
      .fn()
      .mockResolvedValue({ messageToken: 'out-debounce' });
    const worker = new ConversationWorker(db!, { generateReply, sendReply });

    expect(await worker.runOnce()).toBe(false);
    expect(generateReply).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();

    await makeJobReady(accepted.conversationId);
    await runGeneratedAndDelivered(worker);

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({ messages: ['first', 'second'], history: [] }),
    );
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        text: 'burst response',
      }),
    );

    const job = await db!.query<{ status: string }>(
      'SELECT status FROM jobs WHERE conversation_id = $1',
      [accepted.conversationId],
    );
    expect(job.rows).toEqual([{ status: 'completed' }]);
  });

  it('uses a delivered assistant response as context for a later debounce burst', async () => {
    const inputs: TextBurstCompleteInput[] = [];
    const generateReply = vi.fn(async (input: TextBurstCompleteInput) => {
      inputs.push(input);
      return inputs.length === 1 ? 'Here is your draft.' : 'A shorter draft.';
    });
    const sendReply = vi
      .fn()
      .mockImplementation(async ({ turnId }: { turnId: string }) => ({
        messageToken: `out-${turnId}`,
      }));
    const worker = new ConversationWorker(db!, { generateReply, sendReply });

    const first = await acceptText(
      'Write a note to my landlord.',
      'token-turn-1',
    );
    await makeJobReady(first.conversationId);
    await runGeneratedAndDelivered(worker);

    const sentTurn = await db!.query<{ viber_message_token: string }>(
      'SELECT viber_message_token FROM conversation_turns WHERE conversation_id = $1',
      [first.conversationId],
    );
    const outboundToken = sentTurn.rows[0]?.viber_message_token;
    expect(outboundToken).toBeDefined();
    await recordViberDeliveryCallback(db!, {
      event: 'delivered',
      timestamp: Date.now(),
      message_token: outboundToken!,
      user_id: user.id,
    });

    await acceptText('Make it shorter.', 'token-turn-2');
    await makeJobReady(first.conversationId);
    await runGeneratedAndDelivered(worker);

    expect(generateReply).toHaveBeenCalledTimes(2);
    expect(inputs[1]?.messages).toEqual(['Make it shorter.']);
    expect(inputs[1]?.history).toEqual([
      { role: 'user', content: 'Write a note to my landlord.' },
      { role: 'assistant', content: 'Here is your draft.' },
    ]);
    expect(sendReply).toHaveBeenCalledTimes(2);
  });

  it('resets only the target conversation and excludes the reset confirmation from future context', async () => {
    const inputs: TextBurstCompleteInput[] = [];
    const generateReply = vi.fn(async (input: TextBurstCompleteInput) => {
      inputs.push(input);
      return `assistant response ${input.userId}`;
    });
    const sent: string[] = [];
    const sendReply = vi.fn(async (input: { text: string; turnId: string }) => {
      sent.push(input.text);
      return { messageToken: `out-${input.turnId}` };
    });
    const worker = new ConversationWorker(db!, { generateReply, sendReply });

    const firstUser = await acceptText(
      'Private original question.',
      'token-reset-original',
      'reset-user',
    );
    await makeJobReady(firstUser.conversationId);
    await runGeneratedAndDelivered(worker);

    const otherUser = await acceptText(
      'Do not leak this secret.',
      'token-other-user',
      'other-user',
    );
    await makeJobReady(otherUser.conversationId);
    await runGeneratedAndDelivered(worker);

    await acceptText('/reset', 'token-reset-command', 'reset-user');
    await makeJobReady(firstUser.conversationId);
    expect(await worker.runOnce()).toBe(true);

    expect(sent).toContain('Conversation context cleared. Let’s start fresh.');

    await acceptText(
      'What did I ask you before?',
      'token-reset-followup',
      'reset-user',
    );
    await makeJobReady(firstUser.conversationId);
    await runGeneratedAndDelivered(worker);

    const targetFollowUp = inputs.find(
      (input) =>
        input.userId === 'reset-user' &&
        input.messages[0] === 'What did I ask you before?',
    );
    expect(targetFollowUp?.history).toEqual([]);
    expect(JSON.stringify(targetFollowUp?.history)).not.toContain(
      'Do not leak this secret.',
    );

    const oldTargetContent = await db!.query<{ content: string }>(
      'SELECT content FROM messages WHERE conversation_id = $1',
      [firstUser.conversationId],
    );
    expect(
      oldTargetContent.rows.some((row) =>
        row.content.includes('Private original question.'),
      ),
    ).toBe(false);
    const otherUserContent = await db!.query<{ content: string }>(
      'SELECT content FROM messages WHERE conversation_id = $1',
      [otherUser.conversationId],
    );
    expect(
      otherUserContent.rows.some((row) =>
        row.content.includes('Do not leak this secret.'),
      ),
    ).toBe(true);
  });

  it('persists generated content before delivery and retries delivery without regenerating it', async () => {
    const accepted = await acceptText('Ask once.', 'token-retry');
    await makeJobReady(accepted.conversationId);

    const generateReply = vi
      .fn()
      .mockResolvedValue('Persist this exact answer.');
    let attempts = 0;
    const sendReply = vi.fn(async (input: { turnId: string }) => {
      const persisted = await db!.query<{
        content: string;
        delivery_status: string;
      }>(
        `SELECT m.content, t.delivery_status
         FROM conversation_turns t
         JOIN messages m ON m.id = t.assistant_message_id
         WHERE t.id = $1`,
        [input.turnId],
      );
      expect(persisted.rows).toEqual([
        {
          content: 'Persist this exact answer.',
          delivery_status: 'sending',
        },
      ]);

      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('private response must not be logged'), {
          category: 'network',
          retryable: true,
        });
      }
      return { messageToken: 'out-retry-success' };
    });

    const firstWorker = new ConversationWorker(db!, {
      generateReply,
      sendReply,
    });
    expect(await firstWorker.runOnce()).toBe(true);
    expect(await firstWorker.runOnce()).toBe(true);

    const turn = await db!.query<{ id: string; delivery_status: string }>(
      'SELECT id, delivery_status FROM conversation_turns WHERE conversation_id = $1',
      [accepted.conversationId],
    );
    expect(turn.rows[0]?.delivery_status).toBe('retryable_failure');

    await db!.query(
      "UPDATE conversation_turns SET available_at = NOW() - INTERVAL '1 second' WHERE conversation_id = $1",
      [accepted.conversationId],
    );
    await makeJobReady(accepted.conversationId);

    // A new worker instance simulates a process restart; delivery reuses the saved assistant row.
    const restartedGenerate = vi
      .fn()
      .mockRejectedValue(new Error('must not regenerate a persisted response'));
    const restartedWorker = new ConversationWorker(db!, {
      generateReply: restartedGenerate,
      sendReply,
    });
    expect(await restartedWorker.runOnce()).toBe(true);

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(restartedGenerate).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledTimes(2);
    const finalTurn = await db!.query<{
      delivery_status: string;
      delivery_attempts: number;
      assistant_content: string;
    }>(
      `SELECT t.delivery_status, t.delivery_attempts, m.content AS assistant_content
       FROM conversation_turns t
       JOIN messages m ON m.id = t.assistant_message_id
       WHERE t.conversation_id = $1`,
      [accepted.conversationId],
    );
    expect(finalTurn.rows).toEqual([
      {
        delivery_status: 'accepted',
        delivery_attempts: 2,
        assistant_content: 'Persist this exact answer.',
      },
    ]);
  });

  it('recovers a persisted pending reply after a worker crash without regenerating', async () => {
    const accepted = await acceptText(
      'Reply must survive restart.',
      'token-crash',
    );
    await makeJobReady(accepted.conversationId);
    const generateReply = vi.fn().mockResolvedValue('Saved before restart.');
    const sender = vi
      .fn()
      .mockResolvedValue({ messageToken: 'out-after-restart' });
    const generatingWorker = new ConversationWorker(db!, {
      generateReply,
      sendReply: sender,
    });

    expect(await generatingWorker.runOnce()).toBe(true);
    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(sender).not.toHaveBeenCalled();

    await db!.query(
      `UPDATE jobs
       SET status = 'processing', locked_at = NOW() - INTERVAL '5 minutes'
       WHERE conversation_id = $1`,
      [accepted.conversationId],
    );

    const recoveredGenerate = vi
      .fn()
      .mockRejectedValue(new Error('saved reply should be reused'));
    const recoveredSender = vi.fn().mockResolvedValue({
      messageToken: 'out-after-restart',
    });
    const recoveryWorker = new ConversationWorker(db!, {
      staleAfterMs: 1000,
      generateReply: recoveredGenerate,
      sendReply: recoveredSender,
    });

    expect(await recoveryWorker.runOnce()).toBe(true);
    expect(recoveredGenerate).not.toHaveBeenCalled();
    expect(recoveredSender).toHaveBeenCalledTimes(1);

    const turn = await db!.query<{ delivery_status: string }>(
      'SELECT delivery_status FROM conversation_turns WHERE conversation_id = $1',
      [accepted.conversationId],
    );
    expect(turn.rows).toEqual([{ delivery_status: 'accepted' }]);
  });

  it('correlates a delivery callback received before the send response returns', async () => {
    const accepted = await acceptText('Callback race.', 'token-callback-race');
    await makeJobReady(accepted.conversationId);

    const worker = new ConversationWorker(db!, {
      generateReply: vi.fn().mockResolvedValue('Race-safe response.'),
      sendReply: async ({ userId }) => {
        await recordViberDeliveryCallback(db!, {
          event: 'delivered',
          timestamp: Date.now(),
          message_token: 'out-callback-race',
          user_id: userId,
        });
        return { messageToken: 'out-callback-race' };
      },
    });

    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);

    const turn = await db!.query<{
      delivery_status: string;
      viber_message_token: string;
    }>(
      'SELECT delivery_status, viber_message_token FROM conversation_turns WHERE conversation_id = $1',
      [accepted.conversationId],
    );
    expect(turn.rows).toEqual([
      {
        delivery_status: 'delivered',
        viber_message_token: 'out-callback-race',
      },
    ]);
  });

  it('retries transient generation failures at most three times', async () => {
    const accepted = await acceptText(
      'Please retry generation.',
      'token-generation-retry',
    );
    await makeJobReady(accepted.conversationId);
    const generateReply = vi
      .fn()
      .mockRejectedValueOnce(new AiGenerationError('network'))
      .mockRejectedValueOnce(new AiGenerationError('http', 503))
      .mockResolvedValue('Generated after retries.');
    const sendReply = vi
      .fn()
      .mockResolvedValue({ messageToken: 'out-generation-retry' });
    const worker = new ConversationWorker(db!, {
      generateReply,
      sendReply,
      maxGenerationAttempts: 3,
    });

    expect(await worker.runOnce()).toBe(true);
    for (let attempt = 1; attempt < 3; attempt += 1) {
      await db!.query(
        "UPDATE conversation_turns SET available_at = NOW() - INTERVAL '1 second' WHERE conversation_id = $1",
        [accepted.conversationId],
      );
      await makeJobReady(accepted.conversationId);
      expect(await worker.runOnce()).toBe(true);
    }

    expect(generateReply).toHaveBeenCalledTimes(3);
    const retryState = await db!.query<{
      generation_attempts: number;
      generation_status: string;
      delivery_status: string;
    }>(
      'SELECT generation_attempts, generation_status, delivery_status FROM conversation_turns WHERE conversation_id = $1',
      [accepted.conversationId],
    );
    expect(retryState.rows).toEqual([
      {
        generation_attempts: 3,
        generation_status: 'generated',
        delivery_status: 'pending',
      },
    ]);

    expect(await worker.runOnce()).toBe(true);
    expect(sendReply).toHaveBeenCalledTimes(1);
  });

  it('records permanent delivery failure as terminal and exposes only a safe category', async () => {
    const accepted = await acceptText(
      'Never log my full private text.',
      'token-terminal',
    );
    await makeJobReady(accepted.conversationId);

    const errorRecords: Record<string, string | number | boolean>[] = [];
    const logger = {
      info: vi.fn(),
      error: vi.fn((record: Record<string, string | number | boolean>) =>
        errorRecords.push(record),
      ),
    };
    const worker = new ConversationWorker(db!, {
      generateReply: vi.fn().mockResolvedValue('Sensitive generated text.'),
      sendReply: vi.fn().mockRejectedValue(
        Object.assign(new Error('Sensitive generated text.'), {
          category: 'api_rejected',
          retryable: false,
        }),
      ),
      logger,
    });

    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);

    const turn = await db!.query<{
      delivery_status: string;
      failure_stage: string;
      last_error_category: string;
    }>(
      'SELECT delivery_status, failure_stage, last_error_category FROM conversation_turns WHERE conversation_id = $1',
      [accepted.conversationId],
    );
    expect(turn.rows).toEqual([
      {
        delivery_status: 'terminal_failure',
        failure_stage: 'delivery',
        last_error_category: 'api_rejected',
      },
    ]);
    expect(JSON.stringify(errorRecords)).not.toContain(
      'Sensitive generated text.',
    );
  });

  it('bounds transient delivery retries to five attempts', async () => {
    const accepted = await acceptText(
      'Bound retries.',
      'token-bounded-retries',
    );
    await makeJobReady(accepted.conversationId);
    const generateReply = vi.fn().mockResolvedValue('Same response each time.');
    const sendReply = vi.fn().mockRejectedValue(
      Object.assign(new Error('provider response is ambiguous'), {
        category: 'network',
        retryable: true,
      }),
    );
    const worker = new ConversationWorker(db!, {
      generateReply,
      sendReply,
      maxDeliveryAttempts: 5,
    });

    expect(await worker.runOnce()).toBe(true);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) {
        await db!.query(
          "UPDATE conversation_turns SET available_at = NOW() - INTERVAL '1 second' WHERE conversation_id = $1",
          [accepted.conversationId],
        );
        await makeJobReady(accepted.conversationId);
      }
      expect(await worker.runOnce()).toBe(true);
    }

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledTimes(5);
    const turn = await db!.query<{
      delivery_status: string;
      delivery_attempts: number;
      last_error_category: string;
    }>(
      'SELECT delivery_status, delivery_attempts, last_error_category FROM conversation_turns WHERE conversation_id = $1',
      [accepted.conversationId],
    );
    expect(turn.rows).toEqual([
      {
        delivery_status: 'terminal_failure',
        delivery_attempts: 5,
        last_error_category: 'network',
      },
    ]);
  });

  it('recovers a send interrupted after entering the sending state and records ambiguity', async () => {
    const accepted = await acceptText(
      'Was this sent?',
      'token-interrupted-send',
    );
    await makeJobReady(accepted.conversationId);
    const generateReply = vi.fn().mockResolvedValue('Persisted reply.');
    const firstWorker = new ConversationWorker(db!, {
      generateReply,
      sendReply: vi.fn().mockResolvedValue({ messageToken: 'unused' }),
    });
    expect(await firstWorker.runOnce()).toBe(true);

    await db!.query(
      `UPDATE conversation_turns
       SET delivery_status = 'sending', delivery_attempts = 1
       WHERE conversation_id = $1`,
      [accepted.conversationId],
    );
    await db!.query(
      `UPDATE jobs
       SET status = 'processing', locked_at = NOW() - INTERVAL '5 minutes'
       WHERE conversation_id = $1`,
      [accepted.conversationId],
    );

    const logger = { info: vi.fn(), error: vi.fn() };
    const recoveredSend = vi.fn().mockResolvedValue({
      messageToken: 'out-interrupted-retry',
    });
    const recoveryWorker = new ConversationWorker(db!, {
      staleAfterMs: 1_000,
      generateReply: vi
        .fn()
        .mockRejectedValue(
          new Error('must not regenerate the persisted reply'),
        ),
      sendReply: recoveredSend,
      logger,
    });

    expect(await recoveryWorker.runOnce()).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'outbound_reply_recovered_after_interruption',
        category: 'delivery_outcome_unknown',
        willRetry: true,
      }),
    );
    const pending = await db!.query<{
      delivery_status: string;
      last_error_category: string;
    }>(
      'SELECT delivery_status, last_error_category FROM conversation_turns WHERE conversation_id = $1',
      [accepted.conversationId],
    );
    expect(pending.rows).toEqual([
      {
        delivery_status: 'retryable_failure',
        last_error_category: 'delivery_outcome_unknown',
      },
    ]);

    await db!.query(
      "UPDATE conversation_turns SET available_at = NOW() - INTERVAL '1 second' WHERE conversation_id = $1",
      [accepted.conversationId],
    );
    await makeJobReady(accepted.conversationId);
    expect(await recoveryWorker.runOnce()).toBe(true);

    expect(recoveredSend).toHaveBeenCalledTimes(1);
    expect(recoveredSend).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Persisted reply.' }),
    );
  });

  it('treats a Viber failed callback as uncertain terminal state until later delivery confirmation', async () => {
    const accepted = await acceptText(
      'Track provider callbacks.',
      'token-callback-status',
    );
    await makeJobReady(accepted.conversationId);
    const worker = new ConversationWorker(db!, {
      generateReply: vi.fn().mockResolvedValue('Callback-tracked reply.'),
      sendReply: vi
        .fn()
        .mockResolvedValue({ messageToken: 'out-callback-status' }),
    });
    await runGeneratedAndDelivered(worker);

    await recordViberDeliveryCallback(db!, {
      event: 'failed',
      timestamp: Date.now(),
      message_token: 'out-callback-status',
      user_id: user.id,
    });
    const uncertain = await db!.query<{
      delivery_status: string;
      last_error_category: string;
    }>(
      'SELECT delivery_status, last_error_category FROM conversation_turns WHERE conversation_id = $1',
      [accepted.conversationId],
    );
    expect(uncertain.rows).toEqual([
      {
        delivery_status: 'terminal_failure',
        last_error_category: 'viber_failed_callback',
      },
    ]);

    await recordViberDeliveryCallback(db!, {
      event: 'delivered',
      timestamp: Date.now() + 1000,
      message_token: 'out-callback-status',
      user_id: user.id,
    });
    const delivered = await db!.query<{
      delivery_status: string;
      last_error_category: string | null;
    }>(
      'SELECT delivery_status, last_error_category FROM conversation_turns WHERE conversation_id = $1',
      [accepted.conversationId],
    );
    expect(delivered.rows).toEqual([
      { delivery_status: 'delivered', last_error_category: null },
    ]);
  });

  it('does not add a prior terminal generation fallback to subsequent AI context', async () => {
    const accepted = await acceptText(
      'The first request fails.',
      'token-gen-failure',
    );
    await makeJobReady(accepted.conversationId);
    const inputs: TextBurstCompleteInput[] = [];
    const generateReply = vi.fn(async (input: TextBurstCompleteInput) => {
      inputs.push(input);
      if (inputs.length === 1) throw new AiGenerationError('configuration');
      return 'Next response.';
    });
    const sendReply = vi.fn(async ({ turnId }: { turnId: string }) => ({
      messageToken: `out-fallback-${turnId}`,
    }));
    const worker = new ConversationWorker(db!, { generateReply, sendReply });

    await runGeneratedAndDelivered(worker);
    await acceptText('Continue after the error.', 'token-after-failure');
    await makeJobReady(accepted.conversationId);
    await runGeneratedAndDelivered(worker);

    expect(inputs[1]?.history).toEqual([]);
    const turns = await db!.query<{
      generation_status: string;
      delivery_status: string;
    }>(
      'SELECT generation_status, delivery_status FROM conversation_turns WHERE conversation_id = $1 ORDER BY id',
      [accepted.conversationId],
    );
    expect(turns.rows).toEqual([
      { generation_status: 'failed', delivery_status: 'accepted' },
      { generation_status: 'generated', delivery_status: 'accepted' },
    ]);
    const fallback = await db!.query<{ content: string }>(
      `SELECT m.content
       FROM messages m
       JOIN conversation_turns t ON t.id = m.turn_id
       WHERE t.conversation_id = $1
         AND t.generation_status = 'failed'
         AND m.role = 'assistant'`,
      [accepted.conversationId],
    );
    expect(fallback.rows).toEqual([
      {
        content:
          'I can’t prepare a response right now. Please try again shortly.',
      },
    ]);
  });

  it('deduplicates inbound events and serializes concurrent workers for one turn', async () => {
    const first = await acceptText('Generate exactly once.', 'token-duplicate');
    const duplicate = await acceptText(
      'Generate exactly once.',
      'token-duplicate',
    );
    expect(duplicate.duplicate).toBe(true);
    await makeJobReady(first.conversationId);

    const generateReply = vi.fn().mockResolvedValue('One answer.');
    const sendReply = vi
      .fn()
      .mockResolvedValue({ messageToken: 'out-one-answer' });
    const workerA = new ConversationWorker(db!, { generateReply, sendReply });
    const workerB = new ConversationWorker(db!, { generateReply, sendReply });

    const results = await Promise.all([workerA.runOnce(), workerB.runOnce()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(generateReply).toHaveBeenCalledTimes(1);

    await runUntilIdle(workerA);

    const turns = await db!.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM conversation_turns WHERE conversation_id = $1 AND turn_kind = $2',
      [first.conversationId, 'chat'],
    );
    const messages = await db!.query<{
      role: string;
      count: number;
    }>(
      `SELECT role, COUNT(*)::int AS count
       FROM messages
       WHERE conversation_id = $1
       GROUP BY role`,
      [first.conversationId],
    );
    expect(turns.rows).toEqual([{ count: 1 }]);
    expect(messages.rows).toEqual([
      { role: 'assistant', count: 1 },
      { role: 'user', count: 1 },
    ]);
    expect(sendReply).toHaveBeenCalledTimes(1);
  });

  describe('usage accounting and cost controls', () => {
    const budgetConfig = (overrides: Record<string, number | string> = {}) => ({
      pricingModel: 'google/gemma-3-4b-it',
      inputPricePerMillionUsd: 0.05,
      outputPricePerMillionUsd: 0.1,
      userDailyRequestLimit: 50,
      userDailyBudgetUsd: 0.1,
      requestMaxEstimatedCostUsd: 0.01,
      globalDailyBudgetUsd: 2,
      globalMonthlyBudgetUsd: 30,
      economyThresholdPercent: 80,
      economyMaxOutputTokens: 256,
      ...overrides,
    });

    async function createUsageTurn(label: string) {
      const userResult = await db!.query<{ id: string }>(
        `INSERT INTO users (provider, provider_user_id)
         VALUES ('viber', $1) RETURNING id`,
        [`usage-${label}`],
      );
      const userId = userResult.rows[0]!.id;
      const conversationResult = await db!.query<{ id: string }>(
        'INSERT INTO conversations (user_id) VALUES ($1) RETURNING id',
        [userId],
      );
      const conversationId = conversationResult.rows[0]!.id;
      const turnResult = await db!.query<{ id: string }>(
        `INSERT INTO conversation_turns
           (conversation_id, start_position, end_position)
         VALUES ($1, 1, 1) RETURNING id`,
        [conversationId],
      );
      return {
        userId,
        conversationId,
        turnId: turnResult.rows[0]!.id,
        attemptNumber: 1,
      };
    }

    function reservationInput(
      context: Awaited<ReturnType<typeof createUsageTurn>>,
      maxOutputTokens = 64,
    ) {
      return {
        ...context,
        route: 'cheap_text' as const,
        model: 'google/gemma-3-4b-it',
        messages: [
          { role: 'system', content: 'Sofi assistant.' },
          { role: 'user', content: 'hello' },
        ],
        maxOutputTokens,
      };
    }

    it('persists an idempotent reservation and reconciles actual cost once', async () => {
      const context = await createUsageTurn('actual');
      const accounting = new UsageAccountingService(db!, budgetConfig());
      const reservation = await accounting.reserve(reservationInput(context));

      expect(reservation.reservedUsd).toBeGreaterThan(0);
      const reserved = await db!.query<{
        reservation_state: string;
        cost_kind: string;
        initial_reserved_usd: string;
      }>(
        `SELECT reservation_state, cost_kind, initial_reserved_usd::text
         FROM ai_usage_attempts WHERE turn_id = $1 AND attempt_number = 1`,
        [context.turnId],
      );
      expect(reserved.rows[0]).toMatchObject({
        reservation_state: 'reserved',
        cost_kind: 'unknown',
      });
      expect(Number(reserved.rows[0]?.initial_reserved_usd)).toBeGreaterThan(0);

      await accounting.markInFlight(context);
      await accounting.reconcileSuccess(
        context,
        {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          costUsd: 0.000004,
        },
        12,
      );
      await accounting.reconcileSuccess(
        context,
        { promptTokens: 10, completionTokens: 5, costUsd: 0.0009 },
        20,
      );

      const settled = await db!.query<{
        reservation_state: string;
        cost_kind: string;
        provider_cost_usd: string;
        reserved_usd: string;
      }>(
        `SELECT reservation_state, cost_kind, provider_cost_usd::text, reserved_usd::text
         FROM ai_usage_attempts WHERE turn_id = $1 AND attempt_number = 1`,
        [context.turnId],
      );
      expect(settled.rows[0]).toMatchObject({
        reservation_state: 'settled',
        cost_kind: 'actual',
        provider_cost_usd: '0.000004000000',
      });
      expect(Number(settled.rows[0]?.reserved_usd)).toBe(0);
      expect(await db!.query('SELECT id FROM ai_usage_attempts WHERE turn_id = $1', [context.turnId]))
        .toMatchObject({ rowCount: 1 });
    });

    it('keeps a conservative hold when successful provider usage and cost are missing', async () => {
      const context = await createUsageTurn('unknown');
      const accounting = new UsageAccountingService(db!, budgetConfig());
      const reservation = await accounting.reserve(reservationInput(context));
      await accounting.markInFlight(context);
      await accounting.reconcileSuccess(context, undefined, 42);

      const row = await db!.query<{
        reservation_state: string;
        cost_kind: string;
        reserved_usd: string;
      }>(
        `SELECT reservation_state, cost_kind, reserved_usd::text
         FROM ai_usage_attempts WHERE turn_id = $1`,
        [context.turnId],
      );
      expect(row.rows[0]).toMatchObject({
        reservation_state: 'uncertain',
        cost_kind: 'unknown',
      });
      expect(Number(row.rows[0]?.reserved_usd)).toBeCloseTo(reservation.reservedUsd);
    });

    it('fails closed when model pricing is not configured', async () => {
      const context = await createUsageTurn('unknown-model');
      const accounting = new UsageAccountingService(db!, budgetConfig());
      await expect(
        accounting.reserve({
          ...reservationInput(context),
          model: 'unlisted/model',
        }),
      ).rejects.toMatchObject({
        reason: 'pricing_unavailable',
      });
      const rows = await db!.query(
        'SELECT id FROM ai_usage_attempts WHERE turn_id = $1',
        [context.turnId],
      );
      expect(rows.rowCount).toBe(0);
    });

    it('enforces per-user request count before creating another reservation', async () => {
      const first = await createUsageTurn('rate-limit-a');
      const secondTurn = await db!.query<{ id: string }>(
        `INSERT INTO conversation_turns
           (conversation_id, start_position, end_position)
         VALUES ($1, 2, 2) RETURNING id`,
        [first.conversationId],
      );
      const second = { ...first, turnId: secondTurn.rows[0]!.id, attemptNumber: 1 };
      const accounting = new UsageAccountingService(
        db!,
        budgetConfig({ userDailyRequestLimit: 1 }),
      );
      await accounting.reserve(reservationInput(first));
      await expect(accounting.reserve(reservationInput(second))).rejects.toMatchObject({
        reason: 'request_rate_limit',
      });
      const rows = await db!.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM ai_usage_attempts WHERE user_id = $1',
        [first.userId],
      );
      expect(rows.rows[0]?.count).toBe(1);
    });

    it('serializes concurrent reservations against the same global daily ceiling', async () => {
      const first = await createUsageTurn('global-race-a');
      const second = await createUsageTurn('global-race-b');
      const accounting = new UsageAccountingService(
        db!,
        budgetConfig({
          globalDailyBudgetUsd: 0.00002,
          globalMonthlyBudgetUsd: 1,
        }),
      );

      const results = await Promise.allSettled([
        accounting.reserve(reservationInput(first, 100)),
        accounting.reserve(reservationInput(second, 100)),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.reason).toBeInstanceOf(UsageBudgetError);
      expect((rejected as PromiseRejectedResult).reason.reason).toBe('global_daily_budget');
      const rows = await db!.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM ai_usage_attempts',
      );
      expect(rows.rows[0]?.count).toBe(1);
    });

    it('rejects an over-cost request before provider invocation and does not duplicate attempts', async () => {
      const context = await createUsageTurn('request-cost-limit');
      const accounting = new UsageAccountingService(
        db!,
        budgetConfig({ requestMaxEstimatedCostUsd: 0.000001 }),
      );
      await expect(
        accounting.reserve(reservationInput(context, 512)),
      ).rejects.toMatchObject({ reason: 'request_cost_limit' });
      expect(await db!.query('SELECT id FROM ai_usage_attempts')).toMatchObject({
        rowCount: 0,
      });
    });

    it('releases an expired pre-call reservation but preserves expired in-flight ambiguity', async () => {
      const expiredReserved = await createUsageTurn('expiry-reserved');
      const expiredInflight = await createUsageTurn('expiry-inflight');
      const next = await createUsageTurn('expiry-next');
      const accounting = new UsageAccountingService(db!, budgetConfig());
      await accounting.reserve(reservationInput(expiredReserved));
      await accounting.reserve(reservationInput(expiredInflight));
      await accounting.markInFlight(expiredInflight);
      await db!.query(
        `UPDATE ai_usage_attempts SET started_at = NOW() - INTERVAL '11 minutes'
         WHERE turn_id IN ($1, $2)`,
        [expiredReserved.turnId, expiredInflight.turnId],
      );

      await accounting.reserve(reservationInput(next));
      const rows = await db!.query<{
        turn_id: string;
        reservation_state: string;
        reserved_usd: string;
      }>(
        `SELECT turn_id, reservation_state, reserved_usd::text
         FROM ai_usage_attempts WHERE turn_id IN ($1, $2) ORDER BY turn_id`,
        [expiredReserved.turnId, expiredInflight.turnId],
      );
      const released = rows.rows.find((row) => row.turn_id === expiredReserved.turnId);
      const uncertain = rows.rows.find((row) => row.turn_id === expiredInflight.turnId);
      expect(released?.reservation_state).toBe('released');
      expect(Number(released?.reserved_usd)).toBe(0);
      expect(uncertain?.reservation_state).toBe('uncertain');
      expect(Number(uncertain?.reserved_usd)).toBeGreaterThan(0);
    });
  });
});
