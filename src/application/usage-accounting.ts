import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/client.js';
import type { AiRoute, AiUsage } from './ai-router.js';

export interface UsageBudgetConfig {
  pricingModel: string;
  inputPricePerMillionUsd: number;
  outputPricePerMillionUsd: number;
  userDailyRequestLimit: number;
  userDailyBudgetUsd: number;
  globalDailyBudgetUsd: number;
  globalMonthlyBudgetUsd: number;
  economyThresholdPercent: number;
  economyMaxOutputTokens: number;
  webSearchCostPerRequestUsd?: number;
  webSearchMaxRequests?: number;
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
  // Conservative guard, not an exact tokenizer: 8 tokens per UTF-16 code unit plus
  // per-message overhead. Prices are pinned by model and reviewed by operators.
  const codeUnits = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  return Math.ceil(codeUnits * 8 + messages.length * 8);
}

function maximumWebSearchCost(config: UsageBudgetConfig): number {
  return money(
    (config.webSearchCostPerRequestUsd ?? 0) *
      (config.webSearchMaxRequests ?? 0),
  );
}

function reportedWebSearchCost(
  usage: AiUsage | undefined,
  config: UsageBudgetConfig,
): number {
  const count = usage?.webSearchRequests ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) return 0;
  return money(count * (config.webSearchCostPerRequestUsd ?? 0));
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
  const start =
    period === 'day'
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
    const normalEstimate = money(
      estimatedCost(promptTokens, input.maxOutputTokens, this.config) +
        maximumWebSearchCost(this.config),
    );

    return withTransaction(this.db, async (client) => {
      await client.query(mutexSql);
      await client.query(
        'SELECT id FROM usage_budget_mutex WHERE id = 1 FOR UPDATE',
      );
      await this.recoverExpiredReservations(client);

      const userDaySpend = await countedSpend(
        client,
        'user',
        input.userId,
        'day',
      );
      const globalDaySpend = await countedSpend(
        client,
        'global',
        undefined,
        'day',
      );
      const globalMonthSpend = await countedSpend(
        client,
        'global',
        undefined,
        'month',
      );
      const recentAttempts = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ai_usage_attempts
         WHERE user_id = $1
           AND started_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [input.userId],
      );
      if (
        Number(recentAttempts.rows[0]?.count ?? 0) >=
        this.config.userDailyRequestLimit
      ) {
        this.logRejection(input, 'request_rate_limit');
        throw new UsageBudgetError('request_rate_limit');
      }

      const threshold = this.config.economyThresholdPercent / 100;
      const enteringEconomy =
        (globalDaySpend + normalEstimate) / this.config.globalDailyBudgetUsd >=
          threshold ||
        (globalMonthSpend + normalEstimate) /
          this.config.globalMonthlyBudgetUsd >=
          threshold;
      if (enteringEconomy) {
        effectiveMaxOutputTokens = Math.min(
          effectiveMaxOutputTokens,
          this.config.economyMaxOutputTokens,
        );
      }

      const reservationEstimate = money(
        estimatedCost(promptTokens, effectiveMaxOutputTokens, this.config) +
          maximumWebSearchCost(this.config),
      );
      if (userDaySpend + reservationEstimate > this.config.userDailyBudgetUsd) {
        this.logRejection(input, 'user_daily_budget');
        throw new UsageBudgetError('user_daily_budget');
      }
      if (
        globalDaySpend + reservationEstimate >
        this.config.globalDailyBudgetUsd
      ) {
        this.logRejection(input, 'global_daily_budget');
        throw new UsageBudgetError('global_daily_budget');
      }
      if (
        globalMonthSpend + reservationEstimate >
        this.config.globalMonthlyBudgetUsd
      ) {
        this.logRejection(input, 'global_monthly_budget');
        throw new UsageBudgetError('global_monthly_budget');
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ai_usage_attempts (
           user_id, conversation_id, turn_id, attempt_number, route, model,
           started_at, outcome, cost_kind, cost_provenance, reserved_usd,
           reservation_state, initial_reserved_usd, prompt_estimated_tokens
         ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'reserved', 'unknown',
                   'conservative_character_bound', $7, 'reserved', $7, $8)
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
    await withTransaction(this.db, async (client) => {
      await client.query(mutexSql);
      await client.query(
        'SELECT id FROM usage_budget_mutex WHERE id = 1 FOR UPDATE',
      );
      const result = await client.query(
        `UPDATE ai_usage_attempts
         SET reservation_state = 'in_flight', outcome = 'in_flight', started_at = NOW()
         WHERE turn_id = $1 AND attempt_number = $2
           AND reservation_state = 'reserved'`,
        [context.turnId, context.attemptNumber],
      );
      if ((result.rowCount ?? 0) !== 1) {
        throw new Error('usage_reservation_transition_failed');
      }
    });
  }

  async markKnownFailure(
    context: UsageAttemptContext,
    category: string,
    durationMs: number,
  ): Promise<void> {
    await withTransaction(this.db, async (client) => {
      await client.query(mutexSql);
      await client.query(
        'SELECT id FROM usage_budget_mutex WHERE id = 1 FOR UPDATE',
      );
      await client.query(
        `UPDATE ai_usage_attempts
         SET completed_at = NOW(), duration_ms = $3, outcome = 'failure',
             failure_category = $4, reservation_state = 'released',
             reserved_usd = 0, cost_kind = 'unknown'
         WHERE turn_id = $1 AND attempt_number = $2
           AND reservation_state = 'in_flight'`,
        [
          context.turnId,
          context.attemptNumber,
          Math.max(0, durationMs),
          category,
        ],
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
      await client.query(
        'SELECT id FROM usage_budget_mutex WHERE id = 1 FOR UPDATE',
      );
      await client.query(
        `UPDATE ai_usage_attempts
         SET completed_at = NOW(), duration_ms = $3, outcome = 'failure',
             failure_category = $4, reservation_state = 'uncertain',
             cost_kind = 'unknown', cost_provenance = 'ambiguous_provider_outcome'
         WHERE turn_id = $1 AND attempt_number = $2
           AND reservation_state = 'in_flight'`,
        [
          context.turnId,
          context.attemptNumber,
          Math.max(0, durationMs),
          category,
        ],
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
    providerGenerationId?: string,
  ): Promise<void> {
    const actualCost = usage?.costUsd;
    const hasActualCost =
      actualCost !== undefined &&
      Number.isFinite(actualCost) &&
      actualCost >= 0;
    const hasTokens =
      Number.isFinite(usage?.promptTokens) &&
      Number.isFinite(usage?.completionTokens) &&
      usage?.promptTokens !== undefined &&
      usage.completionTokens !== undefined &&
      usage.promptTokens >= 0 &&
      usage.completionTokens >= 0;
    const webSearchRequests = usage?.webSearchRequests ?? 0;
    const hasValidSearchCount =
      Number.isSafeInteger(webSearchRequests) && webSearchRequests >= 0;
    const searchCost = reportedWebSearchCost(usage, this.config);
    const hasBaseCost = hasActualCost || hasTokens;
    const useActualCost =
      hasActualCost && webSearchRequests === 0 && hasValidSearchCount;
    const reconciledCost =
      hasBaseCost && hasValidSearchCount
        ? money(
            (hasActualCost
              ? actualCost
              : estimatedCost(
                  usage!.promptTokens!,
                  usage!.completionTokens!,
                  this.config,
                )) + searchCost,
          )
        : undefined;

    await withTransaction(this.db, async (client) => {
      await client.query(mutexSql);
      await client.query(
        'SELECT id FROM usage_budget_mutex WHERE id = 1 FOR UPDATE',
      );
      if (reconciledCost !== undefined && useActualCost) {
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
            context.turnId,
            context.attemptNumber,
            Math.max(0, durationMs),
            usage?.promptTokens ?? null,
            usage?.completionTokens ?? null,
            usage?.totalTokens ?? null,
            actualCost,
          ],
        );
      } else if (reconciledCost !== undefined) {
        const provenance =
          webSearchRequests > 0
            ? hasActualCost
              ? 'openrouter_model_cost_plus_estimated_search_cost'
              : 'configured_model_rates_plus_estimated_search_cost'
            : 'configured_model_rates';
        await client.query(
          `UPDATE ai_usage_attempts
           SET completed_at = NOW(), duration_ms = $3, outcome = 'success',
               prompt_tokens = $4, completion_tokens = $5, total_tokens = $6,
               provider_cost_usd = NULL, estimated_cost_usd = $7,
               cost_kind = 'estimated', cost_provenance = $8,
               reservation_state = 'settled', reserved_usd = 0, failure_category = NULL
           WHERE turn_id = $1 AND attempt_number = $2
             AND reservation_state = 'in_flight'`,
          [
            context.turnId,
            context.attemptNumber,
            Math.max(0, durationMs),
            usage?.promptTokens ?? null,
            usage?.completionTokens ?? null,
            usage?.totalTokens ?? null,
            reconciledCost,
            provenance,
          ],
        );
      } else {
        // Missing model usage or an invalid tool count makes total cost uncertain.
        // Keep the original hold rather than releasing potentially billable work.
        await client.query(
          `UPDATE ai_usage_attempts
           SET completed_at = NOW(), duration_ms = $3, outcome = 'success',
               prompt_tokens = $4, completion_tokens = $5, total_tokens = $6,
               cost_kind = 'unknown', cost_provenance = 'provider_usage_missing',
               reservation_state = 'uncertain', failure_category = 'usage_missing'
           WHERE turn_id = $1 AND attempt_number = $2
             AND reservation_state = 'in_flight'`,
          [
            context.turnId,
            context.attemptNumber,
            Math.max(0, durationMs),
            usage?.promptTokens ?? null,
            usage?.completionTokens ?? null,
            usage?.totalTokens ?? null,
          ],
        );
      }

      const safeGenerationId =
        providerGenerationId !== undefined &&
        providerGenerationId.length <= 128 &&
        /^[a-zA-Z0-9_.:/-]+$/.test(providerGenerationId)
          ? providerGenerationId
          : undefined;
      if (safeGenerationId) {
        await client.query(
          `UPDATE ai_usage_attempts
           SET provider_generation_id = COALESCE(provider_generation_id, $3)
           WHERE turn_id = $1 AND attempt_number = $2
             AND reservation_state IN ('settled', 'uncertain')`,
          [context.turnId, context.attemptNumber, safeGenerationId],
        );
      }
    });

    const costKind =
      reconciledCost === undefined
        ? 'unknown'
        : useActualCost
          ? 'actual'
          : 'estimated';
    if (costKind === 'unknown') {
      this.logger.error({
        event: 'ai_usage_provider_data_missing',
        turnId: context.turnId,
        attempt: context.attemptNumber,
        category: 'usage_and_cost_missing',
      });
      this.logger.error({
        event: 'ai_usage_reconciliation_incomplete',
        turnId: context.turnId,
        attempt: context.attemptNumber,
        category: 'unknown_cost_retains_reservation',
      });
    } else {
      this.logger.info({
        event: 'ai_usage_reservation_adjusted',
        turnId: context.turnId,
        attempt: context.attemptNumber,
        costKind,
      });
      this.logger.info({
        event: 'ai_usage_reservation_released',
        turnId: context.turnId,
        attempt: context.attemptNumber,
        reason: 'usage_reconciled',
      });
    }
    this.logger.info({
      event: 'ai_usage_reconciled',
      turnId: context.turnId,
      attempt: context.attemptNumber,
      costKind,
      ...(reconciledCost !== undefined ? { costUsd: reconciledCost } : {}),
      ...(webSearchRequests > 0
        ? { webSearchRequests, estimatedWebSearchCostUsd: searchCost }
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
      event:
        reason === 'global_daily_budget' || reason === 'global_monthly_budget'
          ? 'ai_global_budget_ceiling_reached'
          : reason === 'request_rate_limit' || reason === 'user_daily_budget'
            ? 'ai_user_limit_reached'
            : 'ai_budget_guard_rejected',
      turnId: input.turnId,
      route: input.route,
      model: input.model,
      reason,
    });
  }
}
