import { buildApp } from './app.js';
import { createAiRouter } from './application/ai-router.js';
import { handleTextBurstComplete } from './application/text-burst-handler.js';
import { ConversationWorker } from './application/job-worker.js';
import { env } from './config/env.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrations.js';
import { createOpenRouterClient } from './integrations/openrouter/client.js';
import { createViberClient } from './integrations/viber/client.js';

const db = createDb();
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
    )
  : undefined;

try {
  await migrate(db);

  const worker = new ConversationWorker(db, {
    onTextBurstComplete: (input) =>
      handleTextBurstComplete(viberClient, aiRouter, input),
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
