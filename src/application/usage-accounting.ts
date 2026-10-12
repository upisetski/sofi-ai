import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/client.js';
import type { AiRoute, AiUsage } from './ai-router.js';

export interface UsageBudgetConfig {
  pricingModel: string;
  inputPricePerMillionUsd: number;
  outputPricePerMillionUsd: number;
  userDailyRequestLimit: number;
  userDailyBudgetUsd: number;
  requestMaxEstimatedCostUsd: number;
  globalDailyBudgetUsd: number;
  globalMonthlyBudgetUsd: number;
  economyThresholdPercent: number;
  economyMaxOutputTokens: number;
}

export interface UsageAttemptContext {
  userId: string;
  conversationId: string;
  turnId: string;
  attemptNumber: number;
}

export interface UsageReservationInput extends UsageAttemptContext {
  route: AiRoute;
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxOutputTokens: number;
}

export interface UsageReservation {
  reservationId: string;
  maxOutputTokens: number;
  reservedUsd: number;
  economyMode: boolean;
}

export type UsageLimitReason =
  | 'request_rate_limit'
  | 'user_daily_budget'
  | 'request_cost_limit'
  | 'global_daily_budget'
  | 'global_monthly_budget'
  | 'pricing_unavailable';

export class UsageBudgetError extends Error {
  readonly reason: UsageLimitReason;

  constructor(reason: UsageLimitReason) {
    super(reason);
    this.name = 'UsageBudgetError';
    this.reason = reason;
  }
}

interface UsageAccountingLogger {
  info(record: Record<string, string | number | boolean>): void;
  error(record: Record<string, string | number | boolean>): void;
}

const defaultLogger: UsageAccountingLogger = {
  info(record) {
    console.info(JSON.stringify(record));
  },
  error(record) {
    console.error(JSON.stringify(record));
  },
};

const mutexSql = `
  INSERT INTO usage_budget_mutex (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING
`;

function money(value: number): number {
  return Number(value.toFixed(12));
}

function estimatedPromptTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  // Conservative guard, not a tokenizer: 8 tokens per UTF-16 code unit plus
  // per-message overhead. Prices are pinned by model and reviewed by operators.
  const codeUnits = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.ceil(codeUnits * 8 + messages.length * 8);
}

function estimatedCost(
  promptTokens: number,
  completionTokens: number,
  config: UsageBudgetConfig,
): number {
  return money(
    (promptTokens * config.inputPricePerMillionUsd +
      completionTokens * config.outputPricePerMillionUsd) /
      1_000_000,
  );
}

async function countedSpend(
  client: PoolClient,
  scope: 'user' | 'global',
  userId: string | undefined,
  period: 'day' | 'month',
): Promise<number> {
  const start = period === 'day'
    ? `date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
    : `date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  const result = await client.query<{ spend: string | null }>(
    `SELECT COALESCE(SUM(
       CASE
         WHEN reservation_state IN ('reserved', 'in_flight', 'uncertain')
           THEN reserved_usd
         ELSE COALESCE(provider_cost_usd, estimated_cost_usd, 0)
       END
     ), 0)::text AS spend
     FROM ai_usage_attempts
     WHERE started_at >= ${start}
       AND ($1::bigint IS NULL OR user_id = $1)`,
    [scope === 'user' ? userId : null],
  );
  return Number(result.rows[0]?.spend ?? 0);
}

export class UsageAccountingService {
  constructor(
    private readonly db: Pool,
    private readonly config: UsageBudgetConfig,
    private readonly logger: UsageAccountingLogger = defaultLogger,
  ) {}

  async reserve(input: UsageReservationInput): Promise<UsageReservation> {
    if (input.model !== this.config.pricingModel) {
      this.logger.error({
        event: 'ai_usage_pricing_unavailable',
        route: input.route,
        model: input.model,
        turnId: input.turnId,
      });
      throw new UsageBudgetError('pricing_unavailable');
    }

    const promptTokens = estimatedPromptTokens(input.messages);
    let effectiveMaxOutputTokens = input.maxOutputTokens;
    const normalEstimate = estimatedCost(promptTokens, input.maxOutputTokens, this.config);

    return withTransaction(this.db, async (client) => {
      await client.query(mutexSql);
      await client.query('SELECT id FROM usage_budget_mutex WHERE id = 1 FOR UPDATE');
      await this.recoverExpiredReservations(client);

      const userDaySpend = await countedSpend(client, 'user', input.userId, 'day');
      const globalDaySpend = await countedSpend(client, 'global', undefined, 'day');
      const globalMonthSpend = await countedSpend(client, 'global', undefined, 'month');
      const recentAttempts = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ai_usage_attempts
         WHERE user_id = $1
           AND started_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [input.userId],
      );
      if (Number(recentAttempts.rows[0]?.count ?? 0) >= this.config.userDailyRequestLimit) {
        this.logRejection(input, 'request_rate_limit');
        throw new UsageBudgetError('request_rate_limit');
      }

      const threshold = this.config.economyThresholdPercent / 100;
      const enteringEconomy =
        globalDaySpend / this.config.globalDailyBudgetUsd >= threshold ||
        globalMonthSpend / this.config.globalMonthlyBudgetUsd >= threshold ||
        normalEstimate > this.config.requestMaxEstimatedCostUsd;
      if (enteringEconomy) {
        effectiveMaxOutputTokens = Math.min(
          effectiveMaxOutputTokens,
          this.config.economyMaxOutputTokens,
        );
      }

      const reservationEstimate = estimatedCost(
        promptTokens,
        effectiveMaxOutputTokens,
        this.config,
      );
      if (reservationEstimate > this.config.requestMaxEstimatedCostUsd) {
        this.logRejection(input, 'request_cost_limit');
        throw new UsageBudgetError('request_cost_limit');
      }
      if (userDaySpend + reservationEstimate > this.config.userDailyBudgetUsd) {
        this.logRejection(input, 'user_daily_budget');
        throw new UsageBudgetError('user_daily_budget');
      }
      if (globalDaySpend + reservationEstimate > this.config.globalDailyBudgetUsd) {
        this.logRejection(input, 'global_daily_budget');
        throw new UsageBudgetError('global_daily_budget');
      }
      if (globalMonthSpend + reservationEstimate > this.config.globalMonthlyBudgetUsd) {
        this.logRejection(input, 'global_monthly_budget');
        throw new UsageBudgetError('global_monthly_budget');
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ai_usage_attempts (
           user_id, conversation_id, turn_id, attempt_number, route, model,
           started_at, outcome, cost_kind, cost_provenance, reserved_usd,
           reservation_state, prompt_estimated_tokens
         ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'in_flight', 'unknown',
                   'conservative_character_bound', $7, 'reserved', $8)
         ON CONFLICT (turn_id, attempt_number) DO NOTHING
         RETURNING id`,
        [
          input.userId,
          input.conversationId,
          input.turnId,
          input.attemptNumber,
          input.route,
          input.model,
          reservationEstimate,
          promptTokens,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        // A duplicate attempt must never cause a second provider invocation.
        throw new Error('usage_attempt_already_reserved');
      }

      this.logger.info({
        event: 'ai_usage_reservation_created',
        usageId: row.id,
        turnId: input.turnId,
        attempt: input.attemptNumber,
        route: input.route,
        model: input.model,
        reservedUsd: reservationEstimate,
        economyMode: enteringEconomy,
      });
      if (enteringEconomy) {
        this.logger.info({
          event: 'ai_economy_mode_activated',
          route: input.route,
          model: input.model,
          turnId: input.turnId,
          effectiveMaxOutputTokens,
        });
      }

      return {
        reservationId: row.id,
        maxOutputTokens: effectiveMaxOutputTokens,
        reservedUsd: reservationEstimate,
        economyMode: enteringEconomy,
      };
    });
  }

  async markInFlight(context: UsageAttemptContext): Promise<void> {
    const result = await this.db.query(
      `UPDATE ai_usage_attempts
       SET reservation_state = 'in_flight'
       WHERE turn_id = $1 AND attempt_number = $2
         AND reservation_state = 'reserved'`,
      [context.turnId, context.attemptNumber],
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error('usage_reservation_transition_failed');
    }
  }

  async markKnownFailure(
    context: UsageAttemptContext,
    category: string,
    durationMs: number,
  ): Promise<void> {
    await withTransaction(this.db, async (client) => {
      await client.query(mutexSql);
      await client.query('SELECT id FROM usage_budget_mutex WHERE id = 1 FOR UPDATE');
      await client.query(
        `UPDATE ai_usage_attempts
         SET completed_at = NOW(), duration_ms = $3, outcome = 'failure',
             failure_category = $4, reservation_state = 'released',
             reserved_usd = 0, cost_kind = 'unknown'
         WHERE turn_id = $1 AND attempt_number = $2
           AND reservation_state = 'in_flight'`,
        [context.turnId, context.attemptNumber, Math.max(0, durationMs), category],
      );
    });
    this.logger.info({
      event: 'ai_usage_reservation_released',
      turnId: context.turnId,
      attempt: context.attemptNumber,
      category,
    });
  }

  async markAmbiguousFailure(
    context: UsageAttemptContext,
    category: string,
    durationMs: number,
  ): Promise<void> {
    await withTransaction(this.db, async (client) => {
      await client.query(mutexSql);
      await client.query('SELECT id FROM usage_budget_mutex WHERE id = 1 FOR UPDATE');
      await client.query(
        `UPDATE ai_usage_attempts
         SET completed_at = NOW(), duration_ms = $3, outcome = 'failure',
             failure_category = $4, reservation_state = 'uncertain',
             cost_kind = 'unknown', cost_provenance = 'ambiguous_provider_outcome'
         WHERE turn_id = $1 AND attempt_number = $2
           AND reservation_state = 'in_flight'`,
        [context.turnId, context.attemptNumber, Math.max(0, durationMs), category],
      );
    });
    this.logger.error({
      event: 'ai_usage_reconciliation_incomplete',
      turnId: context.turnId,
      attempt: context.attemptNumber,
      category,
    });
  }

  async reconcileSuccess(
    context: UsageAttemptContext,
    usage: AiUsage | undefined,
    durationMs: number,
  ): Promise<void> {
    const actualCost = usage?.costUsd;
    const hasTokens =
      Number.isFinite(usage?.promptTokens) &&
      Number.isFinite(usage?.completionTokens) &&
      usage?.promptTokens !== undefined &&
      usage.completionTokens !== undefined &&
      usage.promptTokens >= 0 &&
      usage.completionTokens >= 0;

    await withTransaction(this.db, async (client) => {
      await client.query(mutexSql);
      await client.query('SELECT id FROM usage_budget_mutex WHERE id = 1 FOR UPDATE');

      if (actualCost !== undefined && Number.isFinite(actualCost) && actualCost >= 0) {
        await client.query(
          `UPDATE ai_usage_attempts
           SET completed_at = NOW(), duration_ms = $3, outcome = 'success',
               prompt_tokens = $4, completion_tokens = $5, total_tokens = $6,
               provider_cost_usd = $7, estimated_cost_usd = NULL,
               cost_kind = 'actual', cost_provenance = 'openrouter_usage_cost',
               reservation_state = 'settled', reserved_usd = 0, failure_category = NULL
           WHERE turn_id = $1 AND attempt_number = $2
             AND reservation_state = 'in_flight'`,
          [
            context.turnId, context.attemptNumber, Math.max(0, durationMs),
            usage?.promptTokens ?? null, usage?.completionTokens ?? null,
            usage?.totalTokens ?? null, actualCost,
          ],
        );
      } else if (hasTokens) {
        const estimate = estimatedCost(
          usage.promptTokens!,
          usage.completionTokens!,
          this.config,
        );
        await client.query(
          `UPDATE ai_usage_attempts
           SET completed_at = NOW(), duration_ms = $3, outcome = 'success',
               prompt_tokens = $4, completion_tokens = $5, total_tokens = $6,
               provider_cost_usd = NULL, estimated_cost_usd = $7,
               cost_kind = 'estimated', cost_provenance = 'configured_model_rates',
               reservation_state = 'settled', reserved_usd = 0, failure_category = NULL
           WHERE turn_id = $1 AND attempt_number = $2
             AND reservation_state = 'in_flight'`,
          [
            context.turnId, context.attemptNumber, Math.max(0, durationMs),
            usage?.promptTokens ?? null, usage?.completionTokens ?? null,
            usage?.totalTokens ?? null, estimate,
          ],
        );
      } else {
        // The provider returned a response but there is insufficient usage data
        // to settle confidently. Keep the hold charged against budget windows.
        await client.query(
          `UPDATE ai_usage_attempts
           SET completed_at = NOW(), duration_ms = $3, outcome = 'success',
               prompt_tokens = $4, completion_tokens = $5, total_tokens = $6,
               reserved_usd = 0, cost_kind = 'unknown', cost_provenance = 'provider_usage_missing',
               reservation_state = 'uncertain', failure_category = 'usage_missing'
           WHERE turn_id = $1 AND attempt_number = $2
             AND reservation_state = 'in_flight'`,
          [
            context.turnId, context.attemptNumber, Math.max(0, durationMs),
            usage?.promptTokens ?? null, usage?.completionTokens ?? null,
            usage?.totalTokens ?? null,
          ],
        );
      }
    });

    this.logger.info({
      event: 'ai_usage_reconciled',
      turnId: context.turnId,
      attempt: context.attemptNumber,
      costKind:
        actualCost !== undefined && Number.isFinite(actualCost) && actualCost >= 0
          ? 'actual'
          : hasTokens ? 'estimated' : 'unknown',
      ...(actualCost !== undefined && Number.isFinite(actualCost) && actualCost >= 0
        ? { costUsd: actualCost }
        : {}),
      durationMs: Math.max(0, durationMs),
    });
  }

  async recordUnexpectedPreProviderFailure(
    context: UsageAttemptContext,
    category: string,
    durationMs: number,
  ): Promise<void> {
    await this.markKnownFailure(context, category, durationMs);
  }

  private async recoverExpiredReservations(client: PoolClient): Promise<void> {
    const released = await client.query(
      `UPDATE ai_usage_attempts
       SET reservation_state = 'released', reserved_usd = 0,
           outcome = 'failure', failure_category = 'reservation_expired_before_call',
           cost_kind = 'unknown', completed_at = COALESCE(completed_at, NOW())
       WHERE reservation_state = 'reserved'
         AND started_at < NOW() - INTERVAL '10 minutes'`,
    );
    const uncertain = await client.query(
      `UPDATE ai_usage_attempts
       SET reservation_state = 'uncertain', outcome = 'failure',
           failure_category = 'provider_outcome_unknown',
           cost_kind = 'unknown', cost_provenance = 'in_flight_reservation_expired',
           completed_at = COALESCE(completed_at, NOW())
       WHERE reservation_state = 'in_flight'
         AND started_at < NOW() - INTERVAL '10 minutes'`,
    );
    if ((released.rowCount ?? 0) > 0 || (uncertain.rowCount ?? 0) > 0) {
      this.logger.info({
        event: 'ai_usage_reservations_recovered',
        released: released.rowCount ?? 0,
        uncertain: uncertain.rowCount ?? 0,
      });
    }
  }

  private logRejection(
    input: UsageReservationInput,
    reason: UsageLimitReason,
  ): void {
    this.logger.info({
      event: reason === 'global_daily_budget' || reason === 'global_monthly_budget'
        ? 'ai_global_budget_ceiling_reached'
        : 'ai_budget_guard_rejected',
      turnId: input.turnId,
      route: input.route,
      model: input.model,
      reason,
    });
  }
}
