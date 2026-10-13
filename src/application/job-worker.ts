import type { Pool, PoolClient } from 'pg';

import {
  AiGenerationError,
  MAX_CONTEXT_MESSAGES,
  type AiContextMessage,
} from './ai-router.js';
import { processConversation } from './conversation-processor.js';
import {
  getAiLimitReachedResponse,
  getAiTemporaryErrorResponse,
} from '../localization/index.js';
import { UsageBudgetError } from './usage-accounting.js';
import { withTransaction } from '../db/client.js';

const jobType = 'process_conversation';
const dayMs = 24 * 60 * 60 * 1000;
const generationBackoffMs = [5_000, 30_000];
const deliveryBackoffMs = [5_000, 30_000, 120_000, 600_000];

export interface TextBurstCompleteInput {
  userId: string;
  language?: string;
  messages: string[];
  history: AiContextMessage[];
  usageContext?: {
    userId: string;
    conversationId: string;
    turnId: string;
    attemptNumber: number;
  };
}

export interface SendReplyInput {
  turnId: string;
  userId: string;
  language?: string;
  text: string;
}

export interface SendReplyResult {
  messageToken?: string;
}

export interface WorkerLogger {
  info(record: Record<string, string | number | boolean>): void;
  error(record: Record<string, string | number | boolean>): void;
}

export interface WorkerOptions {
  pollIntervalMs?: number;
  staleAfterMs?: number;
  maxGenerationAttempts?: number;
  maxDeliveryAttempts?: number;
  retentionCleanupIntervalMs?: number;
  generateReply?: (input: TextBurstCompleteInput) => Promise<string>;
  sendReply?: (input: SendReplyInput) => Promise<SendReplyResult | void>;
  logger?: WorkerLogger;
}

interface ClaimedJob {
  id: string;
  conversationId: string;
  lockClient: PoolClient;
}

interface ActiveTurn {
  id: string;
  conversation_id: string;
  turn_kind: 'chat' | 'reset';
  start_position: string;
  end_position: string;
  context_version: number;
  generation_status: string;
  delivery_status: string;
  generation_attempts: number;
  delivery_attempts: number;
  available_at: Date;
  assistant_message_id: string | null;
  assistant_content: string | null;
  last_error_category: string | null;
  user_id: string;
  account_user_id: string;
  locale: string | null;
}

const defaultLogger: WorkerLogger = {
  info(record) {
    console.info(JSON.stringify(record));
  },
  error(record) {
    console.error(JSON.stringify(record));
  },
};

export class ConversationWorker {
  private readonly pollIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly maxGenerationAttempts: number;
  private readonly maxDeliveryAttempts: number;
  private readonly retentionCleanupIntervalMs: number;
  private readonly generateReply: WorkerOptions['generateReply'];
  private readonly sendReply: WorkerOptions['sendReply'];
  private readonly logger: WorkerLogger;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private nextRetentionCleanupAt = 0;

  constructor(
    private readonly db: Pool,
    options: WorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
    this.maxGenerationAttempts = options.maxGenerationAttempts ?? 3;
    this.maxDeliveryAttempts = options.maxDeliveryAttempts ?? 5;
    this.retentionCleanupIntervalMs =
      options.retentionCleanupIntervalMs ?? dayMs;
    this.generateReply = options.generateReply;
    this.sendReply = options.sendReply;
    this.logger = options.logger ?? defaultLogger;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.pollIntervalMs);

    void this.runOnce();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async runOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    let job: ClaimedJob | null = null;

    try {
      await this.maybeCleanupExpiredContent();
      job = await this.claimJob();
      if (!job) return false;

      try {
        await this.recoverInterruptedTurns(job.conversationId);

        let turn = await this.findNextActiveTurn(job.conversationId);
        if (!turn) {
          await processConversation(this.db, job.conversationId);
          turn = await this.findNextActiveTurn(job.conversationId);
        }

        if (turn && turn.available_at.getTime() <= Date.now()) {
          if (turn.delivery_status === 'not_ready') {
            await this.generateTurn(turn);
          } else {
            await this.deliverTurn(turn);
          }
        }

        await this.finishJob(job.id);
      } catch (error) {
        const category = safeErrorCategory(error);
        this.logger.error({
          event: 'conversation_job_failed',
          jobId: job.id,
          conversationId: job.conversationId,
          category,
        });
        await this.failJob(job.id, category);
      }

      return true;
    } finally {
      if (job) await this.releaseClaimedJob(job);
      this.running = false;
    }
  }

  private async maybeCleanupExpiredContent(): Promise<void> {
    if (Date.now() < this.nextRetentionCleanupAt) return;

    try {
      await withTransaction(this.db, async (client) => {
        await client.query(
          `UPDATE conversation_events e
           SET payload = jsonb_build_object('event', e.event_type, 'redacted', true)
           FROM conversations c
           WHERE e.conversation_id = c.id
             AND e.received_at < NOW() - INTERVAL '30 days'
             AND e.position <= c.last_processed_position
             AND NOT (e.payload @> '{"redacted": true}'::jsonb)`,
        );

        await client.query(
          `DELETE FROM messages m
           WHERE m.created_at < NOW() - INTERVAL '30 days'
             AND NOT EXISTS (
               SELECT 1
               FROM conversation_turns t
               WHERE t.id = m.turn_id
                 AND (
                   t.delivery_status IN ('pending', 'sending', 'retryable_failure')
                   OR (
                     t.delivery_status = 'not_ready'
                     AND t.generation_status IN ('pending', 'generating', 'retryable_failure')
                   )
                 )
             )`,
        );

        await client.query(
          `DELETE FROM conversation_turns t
           WHERE t.created_at < NOW() - INTERVAL '90 days'
             AND t.delivery_status IN ('accepted', 'delivered', 'terminal_failure')
             AND NOT EXISTS (
               SELECT 1 FROM messages m WHERE m.turn_id = t.id
             )`,
        );

        await client.query(
          `DELETE FROM conversation_events e
           WHERE e.received_at < NOW() - INTERVAL '90 days'
             AND e.position <= (
               SELECT c.last_processed_position
               FROM conversations c
               WHERE c.id = e.conversation_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM messages m WHERE m.event_id = e.id
             )`,
        );

        await client.query(
          `DELETE FROM viber_delivery_callbacks
           WHERE received_at < NOW() - INTERVAL '90 days'`,
        );

        await client.query(
          `DELETE FROM ai_usage_attempts
           WHERE started_at < NOW() - INTERVAL '90 days'
             AND reservation_state IN ('settled', 'released', 'uncertain')`,
        );
      });

      this.logger.info({ event: 'conversation_content_retention_completed' });
      this.nextRetentionCleanupAt =
        Date.now() + this.retentionCleanupIntervalMs;
    } catch (error) {
      this.logger.error({
        event: 'conversation_content_retention_failed',
        category: safeErrorCategory(error),
      });
      this.nextRetentionCleanupAt = Date.now() + 60_000;
    }
  }

  private async claimJob(): Promise<ClaimedJob | null> {
    const client = await this.db.connect();
    let keepConnection = false;
    let lockedConversationId: string | undefined;

    try {
      await client.query('BEGIN');

      const result = await client.query<{
        id: string;
        conversation_id: string;
      }>(
        `SELECT id, conversation_id
         FROM jobs
         WHERE type = $1
           AND (
             (status = 'pending' AND available_at <= NOW())
             OR (
               status = 'processing'
               AND locked_at < NOW() - ($2 * INTERVAL '1 millisecond')
             )
           )
         ORDER BY available_at ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [jobType, this.staleAfterMs],
      );

      const job = result.rows[0];
      if (!job) {
        await client.query('COMMIT');
        return null;
      }

      const lockResult = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 84621)) AS locked',
        [job.conversation_id],
      );

      if (!lockResult.rows[0]?.locked) {
        // Do not change the lease when another worker owns this conversation.
        await client.query('COMMIT');
        return null;
      }
      lockedConversationId = job.conversation_id;

      await client.query(
        `UPDATE jobs
         SET status = 'processing',
             locked_at = NOW(),
             attempts = attempts + 1,
             last_error = NULL
         WHERE id = $1`,
        [job.id],
      );

      await client.query('COMMIT');
      keepConnection = true;
      return {
        id: job.id,
        conversationId: job.conversation_id,
        lockClient: client,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (lockedConversationId) {
        await client
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 84621))', [
            lockedConversationId,
          ])
          .catch(() => undefined);
      }
      throw error;
    } finally {
      if (!keepConnection) client.release();
    }
  }

  private async releaseClaimedJob(job: ClaimedJob): Promise<void> {
    try {
      await job.lockClient.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 84621))',
        [job.conversationId],
      );
    } catch {
      // PostgreSQL releases session advisory locks when the connection closes.
    } finally {
      job.lockClient.release();
    }
  }

  private async recoverInterruptedTurns(conversationId: string): Promise<void> {
    await this.db.query(
      `UPDATE conversation_turns
       SET generation_status = 'pending',
           failure_stage = 'generation',
           last_error_category = COALESCE(last_error_category, 'worker_recovery'),
           available_at = NOW(),
           updated_at = NOW()
       WHERE conversation_id = $1
         AND delivery_status = 'not_ready'
         AND generation_status = 'generating'`,
      [conversationId],
    );

    const interrupted = await this.db.query<{
      id: string;
      delivery_attempts: number;
    }>(
      `SELECT id, delivery_attempts
       FROM conversation_turns
       WHERE conversation_id = $1 AND delivery_status = 'sending'`,
      [conversationId],
    );

    for (const turn of interrupted.rows) {
      const terminal = turn.delivery_attempts >= this.maxDeliveryAttempts;
      const retryDelay =
        deliveryBackoffMs[
          Math.min(
            Math.max(turn.delivery_attempts - 1, 0),
            deliveryBackoffMs.length - 1,
          )
        ] ?? 600_000;

      await this.db.query(
        `UPDATE conversation_turns
         SET delivery_status = $2,
             failure_stage = 'delivery',
             last_error_category = 'delivery_outcome_unknown',
             available_at = CASE
               WHEN $2 = 'terminal_failure' THEN available_at
               ELSE NOW() + ($3 * INTERVAL '1 millisecond')
             END,
             updated_at = NOW()
         WHERE id = $1 AND delivery_status = 'sending'`,
        [
          turn.id,
          terminal ? 'terminal_failure' : 'retryable_failure',
          retryDelay,
        ],
      );

      this.logger.error({
        event: 'outbound_reply_recovered_after_interruption',
        turnId: turn.id,
        category: 'delivery_outcome_unknown',
        willRetry: !terminal,
      });
    }
  }

  private async findNextActiveTurn(
    conversationId: string,
  ): Promise<ActiveTurn | null> {
    const result = await this.db.query<ActiveTurn>(
      `SELECT t.id, t.conversation_id, t.turn_kind, t.start_position,
              t.end_position, t.context_version, t.generation_status,
              t.delivery_status, t.generation_attempts, t.delivery_attempts,
              t.available_at, t.assistant_message_id, t.last_error_category,
              m.content AS assistant_content,
              u.provider_user_id AS user_id, c.user_id AS account_user_id, c.locale
       FROM conversation_turns t
       JOIN conversations c ON c.id = t.conversation_id
       JOIN users u ON u.id = c.user_id
       LEFT JOIN messages m ON m.id = t.assistant_message_id
       WHERE t.conversation_id = $1
         AND (
           t.delivery_status IN ('pending', 'sending', 'retryable_failure')
           OR (
             t.delivery_status = 'not_ready'
             AND t.generation_status IN (
               'pending', 'generating', 'retryable_failure', 'failed'
             )
           )
         )
       ORDER BY t.id ASC
       LIMIT 1`,
      [conversationId],
    );

    return result.rows[0] ?? null;
  }

  private async generateTurn(turn: ActiveTurn): Promise<void> {
    if (turn.turn_kind !== 'chat') {
      await this.db.query(
        `UPDATE conversation_turns
         SET generation_status = 'failed',
             delivery_status = 'terminal_failure',
             failure_stage = 'generation',
             last_error_category = 'unexpected_reset_state',
             updated_at = NOW()
         WHERE id = $1 AND delivery_status = 'not_ready'`,
        [turn.id],
      );
      this.logger.error({
        event: 'assistant_reply_generation_terminal_failure',
        turnId: turn.id,
        category: 'unexpected_reset_state',
      });
      return;
    }

    const generationInput = await this.buildGenerationInput(turn);
    if (!generationInput) {
      await this.persistFallbackReply(turn, 'missing_turn_input');
      return;
    }

    if (turn.generation_attempts >= this.maxGenerationAttempts) {
      await this.persistFallbackReply(
        turn,
        turn.last_error_category ?? 'generation_retries_exhausted',
      );
      return;
    }

    const claimed = await this.db.query<{ generation_attempts: number }>(
      `UPDATE conversation_turns
       SET generation_status = 'generating',
           generation_attempts = generation_attempts + 1,
           failure_stage = NULL,
           last_error_category = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND delivery_status = 'not_ready'
         AND generation_status IN ('pending', 'retryable_failure')
       RETURNING generation_attempts`,
      [turn.id],
    );
    const attempt = claimed.rows[0]?.generation_attempts;
    if (attempt === undefined) return;

    generationInput.usageContext = {
      userId: turn.account_user_id,
      conversationId: turn.conversation_id,
      turnId: turn.id,
      attemptNumber: attempt,
    };

    const startedAt = Date.now();
    let text: string;

    try {
      if (!this.generateReply) throw new AiGenerationError('configuration');

      text = (await this.generateReply(generationInput)).trim();
      if (!text) throw new AiGenerationError('malformed_response');
    } catch (error) {
      if (error instanceof UsageBudgetError) {
        await this.persistFallbackReply(
          turn,
          'usage_budget_limit',
          getAiLimitReachedResponse(turn.locale ?? undefined, error.reason)
            .text,
        );
        this.logger.info({
          event: 'ai_request_blocked_by_usage_limit',
          turnId: turn.id,
          attempt,
          reason: error.reason,
        });
        return;
      }

      const category = safeErrorCategory(error);
      const retryable = isRetryableGenerationError(error);
      const shouldRetry = retryable && attempt < this.maxGenerationAttempts;

      if (shouldRetry) {
        const delay =
          generationBackoffMs[
            Math.min(attempt - 1, generationBackoffMs.length - 1)
          ] ?? 30_000;
        await this.db.query(
          `UPDATE conversation_turns
           SET generation_status = 'retryable_failure',
               failure_stage = 'generation',
               last_error_category = $2,
               available_at = NOW() + ($3 * INTERVAL '1 millisecond'),
               updated_at = NOW()
           WHERE id = $1 AND generation_status = 'generating'`,
          [turn.id, category, delay],
        );
      } else {
        await this.persistFallbackReply(turn, category);
      }

      this.logger.error({
        event: 'assistant_reply_generation_failed',
        turnId: turn.id,
        attempt,
        retryable,
        willRetry: shouldRetry,
        category,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    await withTransaction(this.db, async (client) => {
      const message = await client.query<{ id: string }>(
        `INSERT INTO messages (
           conversation_id, turn_id, role, content, event_id,
           position, context_version
         )
         VALUES ($1, $2, 'assistant', $3, NULL, $4, $5)
         RETURNING id`,
        [
          turn.conversation_id,
          turn.id,
          text,
          Number(turn.end_position),
          turn.context_version,
        ],
      );
      const messageId = message.rows[0]?.id;
      if (!messageId) throw new Error('Failed to persist assistant message');

      const updated = await client.query(
        `UPDATE conversation_turns
         SET generation_status = 'generated',
             delivery_status = 'pending',
             assistant_message_id = $2,
             generated_at = NOW(),
             available_at = NOW(),
             failure_stage = NULL,
             last_error_category = NULL,
             updated_at = NOW()
         WHERE id = $1 AND generation_status = 'generating'`,
        [turn.id, messageId],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new Error('Conversation turn state changed during generation');
      }
    });

    this.logger.info({
      event: 'assistant_reply_persisted',
      turnId: turn.id,
      durationMs: Date.now() - startedAt,
      outcome: 'success',
    });
  }

  private async buildGenerationInput(
    turn: ActiveTurn,
  ): Promise<TextBurstCompleteInput | null> {
    const current = await this.db.query<{ id: string; content: string }>(
      `SELECT id, content
       FROM messages
       WHERE turn_id = $1 AND role = 'user'
       ORDER BY id ASC`,
      [turn.id],
    );
    const firstCurrentMessage = current.rows[0];
    if (!firstCurrentMessage) return null;

    const history = await this.db.query<{
      role: 'user' | 'assistant';
      content: string;
    }>(
      `SELECT m.role, m.content
       FROM messages m
       JOIN conversation_turns t ON t.id = m.turn_id
       WHERE m.conversation_id = $1
         AND m.context_version = $2
         AND m.id < $3
         AND t.turn_kind = 'chat'
         AND t.generation_status = 'generated'
         AND t.delivery_status IN ('accepted', 'delivered')
         AND m.role IN ('user', 'assistant')
       ORDER BY m.id DESC
       LIMIT $4`,
      [
        turn.conversation_id,
        turn.context_version,
        firstCurrentMessage.id,
        MAX_CONTEXT_MESSAGES,
      ],
    );

    const orderedHistory = history.rows.reverse().map((message) => ({
      role: message.role,
      content: message.content,
    }));

    return {
      userId: turn.user_id,
      messages: current.rows.map((message) => message.content),
      history: orderedHistory,
      ...(turn.locale ? { language: turn.locale } : {}),
    };
  }

  private async persistFallbackReply(
    turn: ActiveTurn,
    category: string,
    replyText?: string,
  ): Promise<void> {
    await withTransaction(this.db, async (client) => {
      const message = await client.query<{ id: string }>(
        `INSERT INTO messages (
           conversation_id, turn_id, role, content, event_id,
           position, context_version
         )
         VALUES ($1, $2, 'assistant', $3, NULL, $4, $5)
         RETURNING id`,
        [
          turn.conversation_id,
          turn.id,
          replyText ??
            getAiTemporaryErrorResponse(turn.locale ?? undefined).text,
          Number(turn.end_position),
          turn.context_version,
        ],
      );
      const messageId = message.rows[0]?.id;
      if (!messageId) {
        throw new Error('Failed to persist fallback assistant message');
      }

      const updated = await client.query(
        `UPDATE conversation_turns
         SET generation_status = 'failed',
             delivery_status = 'pending',
             assistant_message_id = $2,
             generated_at = NOW(),
             available_at = NOW(),
             failure_stage = 'generation',
             last_error_category = $3,
             updated_at = NOW()
         WHERE id = $1 AND delivery_status = 'not_ready'`,
        [turn.id, messageId, category],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new Error(
          'Conversation turn state changed while persisting fallback',
        );
      }
    });

    this.logger.error({
      event: 'assistant_reply_generation_terminal_failure',
      turnId: turn.id,
      category,
    });
  }

  private async deliverTurn(turn: ActiveTurn): Promise<void> {
    if (!turn.assistant_message_id || turn.assistant_content === null) {
      await this.db.query(
        `UPDATE conversation_turns
         SET delivery_status = 'terminal_failure',
             failure_stage = 'delivery',
             last_error_category = 'missing_persisted_reply',
             updated_at = NOW()
         WHERE id = $1 AND delivery_status IN ('pending', 'retryable_failure')`,
        [turn.id],
      );
      this.logger.error({
        event: 'outbound_reply_terminal_failure',
        turnId: turn.id,
        category: 'missing_persisted_reply',
      });
      return;
    }

    const claimed = await this.db.query<{ delivery_attempts: number }>(
      `UPDATE conversation_turns
       SET delivery_status = 'sending',
           delivery_attempts = delivery_attempts + 1,
           failure_stage = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND delivery_status IN ('pending', 'retryable_failure')
       RETURNING delivery_attempts`,
      [turn.id],
    );
    const attempt = claimed.rows[0]?.delivery_attempts;
    if (attempt === undefined) return;

    const startedAt = Date.now();

    try {
      if (!this.sendReply) {
        await this.db.query(
          `UPDATE conversation_turns
           SET delivery_status = 'terminal_failure', failure_stage = 'delivery',
               last_error_category = 'delivery_unconfigured', updated_at = NOW()
           WHERE id = $1 AND delivery_status = 'sending'`,
          [turn.id],
        );
        this.logger.error({
          event: 'outbound_reply_terminal_failure',
          turnId: turn.id,
          category: 'delivery_unconfigured',
        });
        return;
      }

      const result = await this.sendReply({
        turnId: turn.id,
        userId: turn.user_id,
        text: turn.assistant_content,
        ...(turn.locale ? { language: turn.locale } : {}),
      });
      await this.markTurnAccepted(turn, result?.messageToken);

      this.logger.info({
        event: 'outbound_reply_accepted',
        turnId: turn.id,
        attempt,
        durationMs: Date.now() - startedAt,
        hasMessageToken: Boolean(result?.messageToken),
      });
    } catch (error) {
      const category = safeErrorCategory(error);
      const retryable = isRetryableDeliveryError(error);
      const shouldRetry = retryable && attempt < this.maxDeliveryAttempts;
      const delay =
        deliveryBackoffMs[
          Math.min(attempt - 1, deliveryBackoffMs.length - 1)
        ] ?? 600_000;

      await this.db.query(
        `UPDATE conversation_turns
         SET delivery_status = $2,
             failure_stage = 'delivery',
             last_error_category = $3,
             available_at = CASE
               WHEN $2 = 'terminal_failure' THEN available_at
               ELSE NOW() + ($4 * INTERVAL '1 millisecond')
             END,
             updated_at = NOW()
         WHERE id = $1 AND delivery_status = 'sending'`,
        [
          turn.id,
          shouldRetry ? 'retryable_failure' : 'terminal_failure',
          category,
          delay,
        ],
      );

      this.logger.error({
        event: shouldRetry
          ? 'outbound_reply_retry_scheduled'
          : 'outbound_reply_terminal_failure',
        turnId: turn.id,
        attempt,
        retryable,
        willRetry: shouldRetry,
        category,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  private async markTurnAccepted(
    turn: ActiveTurn,
    messageToken?: string,
  ): Promise<void> {
    await withTransaction(this.db, async (client) => {
      const updated = await client.query(
        `UPDATE conversation_turns
         SET viber_message_token = COALESCE($2, viber_message_token),
             delivery_status = 'accepted',
             accepted_at = COALESCE(accepted_at, NOW()),
             failure_stage = CASE
               WHEN generation_status = 'failed' THEN 'generation'
               ELSE NULL
             END,
             last_error_category = CASE
               WHEN generation_status = 'failed' THEN last_error_category
               ELSE NULL
             END,
             updated_at = NOW()
         WHERE id = $1 AND delivery_status = 'sending'`,
        [turn.id, messageToken ?? null],
      );
      if ((updated.rowCount ?? 0) !== 1) return;

      if (!messageToken) return;
      const buffered = await client.query<{
        event_type: 'delivered' | 'seen' | 'failed';
        occurred_at: Date;
      }>(
        `SELECT event_type, occurred_at
         FROM viber_delivery_callbacks
         WHERE message_token = $1 AND user_id = $2`,
        [messageToken, turn.user_id],
      );
      const callback = buffered.rows[0];
      if (!callback) return;

      const success =
        callback.event_type === 'delivered' || callback.event_type === 'seen';
      await client.query(
        `UPDATE conversation_turns
         SET delivery_status = $2,
             delivered_at = CASE
               WHEN $2 = 'delivered' THEN COALESCE(delivered_at, $3)
               ELSE delivered_at
             END,
             failure_stage = CASE
               WHEN $2 = 'delivered' THEN
                 CASE WHEN generation_status = 'failed' THEN 'generation' ELSE NULL END
               ELSE 'delivery'
             END,
             last_error_category = CASE
               WHEN $2 = 'delivered' THEN
                 CASE WHEN generation_status = 'failed' THEN last_error_category ELSE NULL END
               ELSE 'viber_failed_callback'
             END,
             updated_at = NOW()
         WHERE id = $1`,
        [
          turn.id,
          success ? 'delivered' : 'terminal_failure',
          callback.occurred_at,
        ],
      );
    });
  }

  private async finishJob(id: string): Promise<void> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      const jobResult = await client.query<{
        conversation_id: string;
        available_at: Date;
      }>(
        'SELECT conversation_id, available_at FROM jobs WHERE id = $1 FOR UPDATE',
        [id],
      );
      const job = jobResult.rows[0];

      if (!job) {
        await client.query('COMMIT');
        return;
      }

      const pendingEvents = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM conversation_events
           WHERE conversation_id = $1
             AND position > (
               SELECT last_processed_position
               FROM conversations
               WHERE id = $1
             )
         ) AS exists`,
        [job.conversation_id],
      );
      const hasPendingEvents = Boolean(pendingEvents.rows[0]?.exists);

      const activeTurn = await client.query<{ available_at: Date }>(
        `SELECT available_at
         FROM conversation_turns
         WHERE conversation_id = $1
           AND (
             delivery_status IN ('pending', 'sending', 'retryable_failure')
             OR (
               delivery_status = 'not_ready'
               AND generation_status IN ('pending', 'generating', 'retryable_failure', 'failed')
             )
           )
         ORDER BY id ASC
         LIMIT 1`,
        [job.conversation_id],
      );

      const activeTurnAt = activeTurn.rows[0]?.available_at;
      const now = Date.now();
      const inboundAt =
        hasPendingEvents && job.available_at.getTime() > now
          ? job.available_at.getTime()
          : hasPendingEvents
            ? now
            : undefined;
      const turnAt = activeTurnAt?.getTime();
      const nextWakeAt =
        inboundAt === undefined
          ? turnAt
          : turnAt === undefined
            ? inboundAt
            : Math.min(inboundAt, turnAt);

      if (nextWakeAt === undefined) {
        await client.query(
          `UPDATE jobs
           SET status = 'completed',
               locked_at = NULL,
               completed_at = NOW(),
               last_error = NULL
           WHERE id = $1`,
          [id],
        );
      } else {
        await client.query(
          `UPDATE jobs
           SET status = 'pending',
               available_at = TO_TIMESTAMP($2 / 1000.0),
               locked_at = NULL,
               completed_at = NULL
           WHERE id = $1`,
          [id, nextWakeAt],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async failJob(id: string, category: string): Promise<void> {
    await this.db.query(
      `UPDATE jobs
       SET status = 'pending',
           locked_at = NULL,
           available_at = GREATEST(
             available_at,
             NOW() + INTERVAL '1 second'
           ),
           last_error = $2,
           completed_at = NULL
       WHERE id = $1`,
      [id, `worker_error:${category}`],
    );
  }
}

function safeErrorCategory(error: unknown): string {
  if (error instanceof AiGenerationError) {
    if (
      error.kind === 'http' &&
      Number.isInteger(error.httpStatus) &&
      error.httpStatus !== undefined
    ) {
      return `http_${error.httpStatus}`;
    }
    return error.kind;
  }

  if (error && typeof error === 'object') {
    const candidate = error as {
      category?: unknown;
      kind?: unknown;
      httpStatus?: unknown;
      providerStatus?: unknown;
    };
    const status =
      typeof candidate.httpStatus === 'number' &&
      Number.isInteger(candidate.httpStatus) &&
      candidate.httpStatus >= 100 &&
      candidate.httpStatus <= 599
        ? candidate.httpStatus
        : typeof candidate.providerStatus === 'number' &&
            Number.isInteger(candidate.providerStatus) &&
            candidate.providerStatus >= 0 &&
            candidate.providerStatus <= 999
          ? candidate.providerStatus
          : undefined;

    for (const value of [candidate.category, candidate.kind]) {
      if (typeof value === 'string' && /^[a-z0-9_]{1,40}$/i.test(value)) {
        return status === undefined
          ? value.toLowerCase()
          : `${value.toLowerCase()}_${status}`;
      }
    }
  }

  return 'unexpected';
}

function isRetryableGenerationError(error: unknown): boolean {
  if (!(error instanceof AiGenerationError)) return false;
  if (error.kind === 'network' || error.kind === 'timeout') return true;

  return (
    error.kind === 'http' &&
    typeof error.httpStatus === 'number' &&
    (error.httpStatus === 429 || error.httpStatus >= 500)
  );
}

function isRetryableDeliveryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const candidate = error as { retryable?: unknown };
  return typeof candidate.retryable === 'boolean' ? candidate.retryable : true;
}
