import Fastify from 'fastify';
import helmet from '@fastify/helmet';

import type { Db } from './db/client.js';
import { createViberWebhookHandler } from './integrations/viber/webhook.js';

export interface AppOptions {
  db?: Db;
  reorderDelayMs?: number;
}

export function buildApp(options: AppOptions = {}) {
  const isProduction = process.env.NODE_ENV === 'production';

  const app = Fastify(
    isProduction
      ? { logger: true }
      : {
          logger: {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true },
            },
          },
        },
  );

  app.register(helmet);

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/viber/webhook', createViberWebhookHandler(options));

  return app;
}
