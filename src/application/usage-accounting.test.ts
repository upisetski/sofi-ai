import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  UsageAccountingService,
  type UsageBudgetConfig,
} from './usage-accounting.js';

const config: UsageBudgetConfig = {
  pricingModel: 'openai/gpt-6-luna',
  inputPricePerMillionUsd: 0.1,
  outputPricePerMillionUsd: 0.5,
  userDailyRequestLimit: 50,
  userDailyBudgetUsd: 0.2,
  globalDailyBudgetUsd: 2,
  globalMonthlyBudgetUsd: 30,
  economyThresholdPercent: 80,
  economyMaxOutputTokens: 256,
};

describe('UsageAccountingService', () => {
  it('finalizes aged uncertain attempts at the original conservative reservation', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);

        if (sql.includes("WHERE reservation_state = 'uncertain'")) {
          return { rows: [], rowCount: 2 };
        }
        if (sql.includes('AS spend')) {
          return { rows: [{ spend: '0' }], rowCount: 1 };
        }
        if (sql.includes('COUNT(*)::text AS count')) {
          return { rows: [{ count: '0' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO ai_usage_attempts')) {
          return { rows: [{ id: 'usage-new' }], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const db = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;
    const logger = { info: vi.fn(), error: vi.fn() };
    const service = new UsageAccountingService(
      db,
      config,
      logger as unknown as ConstructorParameters<
        typeof UsageAccountingService
      >[2],
    );

    await service.reserve({
      userId: '1',
      conversationId: '2',
      turnId: '3',
      attemptNumber: 1,
      route: 'cheap_text',
      model: config.pricingModel,
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 512,
    });

    const finalization = statements.find((sql) =>
      sql.includes("WHERE reservation_state = 'uncertain'"),
    );

    expect(finalization).toContain(
      "started_at < NOW() - INTERVAL '24 hours'",
    );
    expect(finalization).toContain(
      'estimated_cost_usd = GREATEST(reserved_usd, initial_reserved_usd)',
    );
    expect(finalization).toContain("reservation_state = 'settled'");
    expect(finalization).toContain('reserved_usd = 0');
    expect(finalization).toContain("cost_kind = 'estimated'");
    expect(finalization).toContain(
      "cost_provenance = 'conservative_reservation_after_ambiguous_outcome'",
    );
    const spendQuery = statements.find((sql) => sql.includes('AS spend'));
    expect(spendQuery).toContain(
      "WHEN reservation_state IN ('reserved', 'in_flight', 'uncertain')",
    );
    expect(spendQuery).toContain(
      'COALESCE(provider_cost_usd, estimated_cost_usd, 0)',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ai_usage_uncertain_reservations_finalized',
        count: 2,
        costKind: 'estimated',
      }),
    );
    expect(client.release).toHaveBeenCalledOnce();
  });
});
