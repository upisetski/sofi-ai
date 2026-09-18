import type { Pool } from 'pg';

import { processConversation } from './conversation-processor.js';

const jobType = 'process_conversation';

export interface WorkerOptions {
  pollIntervalMs?: number;
  staleAfterMs?: number;
}

export class ConversationWorker {
  private readonly pollIntervalMs: number;
  private readonly staleAfterMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Pool,
    options: WorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
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

    try {
      const job = await this.claimJob();
      if (!job) return false;

      try {
        await processConversation(this.db, job.conversationId);
        await this.finishJob(job.id);
      } catch (error) {
        await this.failJob(
          job.id,
          error instanceof Error ? error.message : 'unknown error',
        );
      }

      return true;
    } finally {
      this.running = false;
    }
  }

  private async claimJob(): Promise<{ id: string; conversationId: string } | null> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query<{
        id: string;
        conversation_id: string;
      }>(
        `
          SELECT id, conversation_id
          FROM jobs
          WHERE type = $1
            AND (
              (status = 'pending' AND available_at <= NOW())
              OR (status = 'processing' AND locked_at < NOW() - ($2 * INTERVAL '1 millisecond'))
            )
          ORDER BY available_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `,
        [jobType, this.staleAfterMs],
      );

      const job = result.rows[0];
      if (!job) {
        await client.query('COMMIT');
        return null;
      }

      await client.query(
        `
          UPDATE jobs
          SET status = 'processing',
              locked_at = NOW(),
              attempts = attempts + 1,
              last_error = NULL
          WHERE id = $1
        `,
        [job.id],
      );

      await client.query('COMMIT');
      return { id: job.id, conversationId: job.conversation_id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async finishJob(id: string): Promise<void> {
    await this.db.query(
      `
        UPDATE jobs
        SET status = 'completed', locked_at = NULL, completed_at = NOW()
        WHERE id = $1
      `,
      [id],
    );
  }

  private async failJob(id: string, error: string): Promise<void> {
    await this.db.query(
      `
        UPDATE jobs
        SET status = 'pending',
            locked_at = NULL,
            available_at = NOW() + INTERVAL '1 second',
            last_error = $2
        WHERE id = $1
      `,
      [id, error.slice(0, 1000)],
    );
  }
}
