import { buildApp } from './app.js';
import { handleTextBurstComplete } from './application/text-burst-handler.js';
import { ConversationWorker } from './application/job-worker.js';
import { env } from './config/env.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrations.js';
import { createViberClient } from './integrations/viber/client.js';

const db = createDb();
const viberClient = createViberClient({ authToken: env.VIBER_AUTH_TOKEN });

try {
  await migrate(db);

  const worker = new ConversationWorker(db, {
    onTextBurstComplete: (input) =>
      handleTextBurstComplete(viberClient, input),
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
