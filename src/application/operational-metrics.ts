import type { Db } from '../db/client.js';

interface UsageAggregateRow {
  attempts_24h: string | number;
  successes_24h: string | number;
  failures_24h: string | number;
  p95_latency_ms_24h: string | number;
  settled_cost_usd_24h: string | number;
  reserved_cost_usd_24h: string | number;
  unknown_cost_attempts_24h: string | number;
  attempts_7d: string | number;
  successes_7d: string | number;
  failures_7d: string | number;
  p95_latency_ms_7d: string | number;
  settled_cost_usd_7d: string | number;
  reserved_cost_usd_7d: string | number;
  unknown_cost_attempts_7d: string | number;
}

interface ReplyAggregateRow {
  turns_created_24h: string | number;
  replies_generated_24h: string | number;
  replies_delivered_24h: string | number;
  generation_failures_24h: string | number;
  delivery_failures_24h: string | number;
  pending_replies_24h: string | number;
  turns_created_7d: string | number;
  replies_generated_7d: string | number;
  replies_delivered_7d: string | number;
  generation_failures_7d: string | number;
  delivery_failures_7d: string | number;
  pending_replies_7d: string | number;
}

interface UserAggregateRow {
  active_users_24h: string | number;
  active_users_7d: string | number;
  returning_users_7d: string | number;
}

function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usd(value: string | number | null | undefined): number {
  return Math.round(numeric(value) * 1_000_000) / 1_000_000;
}

export async function getOperationalMetrics(db: Db) {
  const [usageResult, replyResult, userResult] = await Promise.all([
    db.query<UsageAggregateRow>(`
      SELECT
        COUNT(*) FILTER (
          WHERE started_at >= NOW() - INTERVAL '24 hours'
        ) AS attempts_24h,
        COUNT(*) FILTER (
          WHERE started_at >= NOW() - INTERVAL '24 hours'
            AND outcome = 'success'
        ) AS successes_24h,
        COUNT(*) FILTER (
          WHERE started_at >= NOW() - INTERVAL '24 hours'
            AND outcome = 'failure'
        ) AS failures_24h,
        COALESCE(
          percentile_cont(0.95) WITHIN GROUP (
            ORDER BY duration_ms::double precision
          ) FILTER (
            WHERE started_at >= NOW() - INTERVAL '24 hours'
              AND duration_ms IS NOT NULL
          ),
          0
        )::bigint AS p95_latency_ms_24h,
        COALESCE(
          SUM(
            CASE
              WHEN reservation_state IN ('reserved', 'in_flight', 'uncertain')
                THEN 0
              WHEN reservation_state IN ('settled', 'released')
                THEN COALESCE(provider_cost_usd, estimated_cost_usd, 0)
              ELSE 0
            END
          ) FILTER (
            WHERE started_at >= NOW() - INTERVAL '24 hours'
          ),
          0
        )::numeric(20, 6) AS settled_cost_usd_24h,
        COALESCE(
          SUM(
            CASE
              WHEN reservation_state IN ('reserved', 'in_flight', 'uncertain')
                THEN reserved_usd
              ELSE 0
            END
          ) FILTER (
            WHERE started_at >= NOW() - INTERVAL '24 hours'
          ),
          0
        )::numeric(20, 6) AS reserved_cost_usd_24h,
        COUNT(*) FILTER (
          WHERE started_at >= NOW() - INTERVAL '24 hours'
            AND cost_kind = 'unknown'
        ) AS unknown_cost_attempts_24h,
        COUNT(*) FILTER (
          WHERE started_at >= NOW() - INTERVAL '7 days'
        ) AS attempts_7d,
        COUNT(*) FILTER (
          WHERE started_at >= NOW() - INTERVAL '7 days'
            AND outcome = 'success'
        ) AS successes_7d,
        COUNT(*) FILTER (
          WHERE started_at >= NOW() - INTERVAL '7 days'
            AND outcome = 'failure'
        ) AS failures_7d,
        COALESCE(
          percentile_cont(0.95) WITHIN GROUP (
            ORDER BY duration_ms::double precision
          ) FILTER (
            WHERE started_at >= NOW() - INTERVAL '7 days'
              AND duration_ms IS NOT NULL
          ),
          0
        )::bigint AS p95_latency_ms_7d,
        COALESCE(
          SUM(
            CASE
              WHEN reservation_state IN ('reserved', 'in_flight', 'uncertain')
                THEN 0
              WHEN reservation_state IN ('settled', 'released')
                THEN COALESCE(provider_cost_usd, estimated_cost_usd, 0)
              ELSE 0
            END
          ) FILTER (
            WHERE started_at >= NOW() - INTERVAL '7 days'
          ),
          0
        )::numeric(20, 6) AS settled_cost_usd_7d,
        COALESCE(
          SUM(
            CASE
              WHEN reservation_state IN ('reserved', 'in_flight', 'uncertain')
                THEN reserved_usd
              ELSE 0
            END
          ) FILTER (
            WHERE started_at >= NOW() - INTERVAL '7 days'
          ),
          0
        )::numeric(20, 6) AS reserved_cost_usd_7d,
        COUNT(*) FILTER (
          WHERE started_at >= NOW() - INTERVAL '7 days'
            AND cost_kind = 'unknown'
        ) AS unknown_cost_attempts_7d
      FROM ai_usage_attempts
    `),
    db.query<ReplyAggregateRow>(`
      SELECT
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '24 hours'
            AND turn_kind = 'chat'
        ) AS turns_created_24h,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '24 hours'
            AND turn_kind = 'chat'
            AND generation_status = 'generated'
        ) AS replies_generated_24h,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '24 hours'
            AND turn_kind = 'chat'
            AND delivery_status = 'delivered'
        ) AS replies_delivered_24h,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '24 hours'
            AND turn_kind = 'chat'
            AND generation_status = 'failed'
        ) AS generation_failures_24h,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '24 hours'
            AND turn_kind = 'chat'
            AND delivery_status = 'terminal_failure'
        ) AS delivery_failures_24h,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '24 hours'
            AND turn_kind = 'chat'
            AND delivery_status IN (
              'not_ready', 'pending', 'sending', 'retryable_failure'
            )
        ) AS pending_replies_24h,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '7 days'
            AND turn_kind = 'chat'
        ) AS turns_created_7d,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '7 days'
            AND turn_kind = 'chat'
            AND generation_status = 'generated'
        ) AS replies_generated_7d,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '7 days'
            AND turn_kind = 'chat'
            AND delivery_status = 'delivered'
        ) AS replies_delivered_7d,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '7 days'
            AND turn_kind = 'chat'
            AND generation_status = 'failed'
        ) AS generation_failures_7d,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '7 days'
            AND turn_kind = 'chat'
            AND delivery_status = 'terminal_failure'
        ) AS delivery_failures_7d,
        COUNT(*) FILTER (
          WHERE created_at >= NOW() - INTERVAL '7 days'
            AND turn_kind = 'chat'
            AND delivery_status IN (
              'not_ready', 'pending', 'sending', 'retryable_failure'
            )
        ) AS pending_replies_7d
      FROM conversation_turns
    `),
    db.query<UserAggregateRow>(`
      WITH recent_user_turns AS (
        SELECT c.user_id, t.created_at
        FROM conversation_turns t
        JOIN conversations c ON c.id = t.conversation_id
        WHERE t.turn_kind = 'chat'
          AND t.created_at >= NOW() - INTERVAL '90 days'
      )
      SELECT
        COUNT(DISTINCT user_id) FILTER (
          WHERE created_at >= NOW() - INTERVAL '24 hours'
        ) AS active_users_24h,
        COUNT(DISTINCT user_id) FILTER (
          WHERE created_at >= NOW() - INTERVAL '7 days'
        ) AS active_users_7d,
        COUNT(DISTINCT current_turn.user_id) FILTER (
          WHERE current_turn.created_at >= NOW() - INTERVAL '7 days'
            AND EXISTS (
              SELECT 1
              FROM recent_user_turns previous_turn
              WHERE previous_turn.user_id = current_turn.user_id
                AND previous_turn.created_at < NOW() - INTERVAL '7 days'
            )
        ) AS returning_users_7d
      FROM recent_user_turns current_turn
    `),
  ]);

  const usage = usageResult.rows[0];
  const replies = replyResult.rows[0];
  const users = userResult.rows[0];
  if (!usage || !replies || !users) {
    throw new Error('operational_metrics_aggregate_missing');
  }

  return {
    generatedAt: new Date().toISOString(),
    ai: {
      last24Hours: {
        attempts: numeric(usage.attempts_24h),
        successes: numeric(usage.successes_24h),
        failures: numeric(usage.failures_24h),
        p95LatencyMs: numeric(usage.p95_latency_ms_24h),
        settledCostUsd: usd(usage.settled_cost_usd_24h),
        reservedCostExposureUsd: usd(usage.reserved_cost_usd_24h),
        unknownCostAttempts: numeric(usage.unknown_cost_attempts_24h),
      },
      last7Days: {
        attempts: numeric(usage.attempts_7d),
        successes: numeric(usage.successes_7d),
        failures: numeric(usage.failures_7d),
        p95LatencyMs: numeric(usage.p95_latency_ms_7d),
        settledCostUsd: usd(usage.settled_cost_usd_7d),
        reservedCostExposureUsd: usd(usage.reserved_cost_usd_7d),
        unknownCostAttempts: numeric(usage.unknown_cost_attempts_7d),
      },
    },
    replies: {
      last24Hours: {
        turnsCreated: numeric(replies.turns_created_24h),
        generated: numeric(replies.replies_generated_24h),
        delivered: numeric(replies.replies_delivered_24h),
        generationFailures: numeric(replies.generation_failures_24h),
        deliveryFailures: numeric(replies.delivery_failures_24h),
        pending: numeric(replies.pending_replies_24h),
      },
      last7Days: {
        turnsCreated: numeric(replies.turns_created_7d),
        generated: numeric(replies.replies_generated_7d),
        delivered: numeric(replies.replies_delivered_7d),
        generationFailures: numeric(replies.generation_failures_7d),
        deliveryFailures: numeric(replies.delivery_failures_7d),
        pending: numeric(replies.pending_replies_7d),
      },
    },
    users: {
      active24Hours: numeric(users.active_users_24h),
      active7Days: numeric(users.active_users_7d),
      returning7Days: numeric(users.returning_users_7d),
    },
  };
}
