import { buildApp } from './app.js';
import { createAiRouter } from './application/ai-router.js';
import { handleTextBurstComplete } from './application/text-burst-handler.js';
import { ConversationWorker } from './application/job-worker.js';
import { env } from './config/env.js';
import { createDb } from './db/client.js';
import { UsageAccountingService } from './application/usage-accounting.js';
import { migrate } from './db/migrations.js';
import { createOpenRouterClient } from './integrations/openrouter/client.js';
import { createViberClient } from './integrations/viber/client.js';
import { getWelcome } from './localization/index.js';

const db = createDb();
const usageAccounting = new UsageAccountingService(db, {
  pricingModel: env.AI_USAGE_PRICING_MODEL,
  inputPricePerMillionUsd: env.AI_USAGE_INPUT_PRICE_PER_MILLION_USD,
  outputPricePerMillionUsd: env.AI_USAGE_OUTPUT_PRICE_PER_MILLION_USD,
  userDailyRequestLimit: env.AI_USER_DAILY_REQUEST_LIMIT,
  userDailyBudgetUsd: env.AI_USER_DAILY_BUDGET_USD,
  requestMaxEstimatedCostUsd: env.AI_REQUEST_MAX_ESTIMATED_COST_USD,
  globalDailyBudgetUsd: env.AI_GLOBAL_DAILY_BUDGET_USD,
  globalMonthlyBudgetUsd: env.AI_GLOBAL_MONTHLY_BUDGET_USD,
  economyThresholdPercent: env.AI_ECONOMY_THRESHOLD_PERCENT,
  economyMaxOutputTokens: env.AI_ECONOMY_MAX_OUTPUT_TOKENS,
});
const viberClient = createViberClient({ authToken: env.VIBER_AUTH_TOKEN });
const aiRouter = env.AI_ENABLED
  ? createAiRouter(
      {
        models: { cheap_text: env.AI_MODEL_CHEAP_TEXT },
        maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
        requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
      },
      createOpenRouterClient({
        ...(env.OPENROUTER_API_KEY ? { apiKey: env.OPENROUTER_API_KEY } : {}),
      }),
      undefined,
      usageAccounting,
    )
  : undefined;

try {
  await migrate(db);

  const worker = new ConversationWorker(db, {
    generateReply: (input) => handleTextBurstComplete(aiRouter, input),
    sendReply: (input) =>
      viberClient.sendTextMessage({
        receiver: input.userId,
        senderName: getWelcome(input.language).senderName,
        text: input.text,
      }),
  });
  worker.start();

  const app = buildApp({
    db,
    reorderDelayMs: env.REORDER_DELAY_MS,
    messageDebounceMs: env.MESSAGE_DEBOUNCE_MS,
  });

  await app.listen({
    host: env.HOST,
    port: env.PORT,
  });

  const shutdown = async () => {
    await app.close();
    await worker.stop();
    await db.end();
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
} catch (error) {
  await db.end();
  console.error(error);
  process.exit(1);
}
