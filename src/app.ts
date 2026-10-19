import { timingSafeEqual } from 'node:crypto';

import Fastify from 'fastify';
import helmet from '@fastify/helmet';

import { getOperationalMetrics } from './application/operational-metrics.js';
import type { Db } from './db/client.js';
import { createViberWebhookHandler } from './integrations/viber/webhook.js';

export interface AppOptions {
  db?: Db;
  reorderDelayMs?: number;
  messageDebounceMs?: number;
  opsMetricsToken?: string;
  logLevel?: string;
}

export function buildApp(options: AppOptions = {}) {
  const isProduction = process.env.NODE_ENV === 'production';

  const app = Fastify(
    isProduction
      ? { logger: { level: options.logLevel ?? 'info' } }
      : {
          logger: {
            level: options.logLevel ?? 'info',
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

  app.get('/health', async (_request, reply) => {
    if (!options.db) {
      return { status: 'ok' };
    }

    try {
      await options.db.query('SELECT 1');
      return { status: 'ok' };
    } catch (error) {
      app.log.error({ err: error }, 'database readiness check failed');
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  app.get('/ops/metrics', async (request, reply) => {
    reply.header('cache-control', 'no-store');

    if (!options.opsMetricsToken) {
      return reply.code(404).send({ status: 'not_found' });
    }

    if (
      !isAuthorized(request.headers.authorization, options.opsMetricsToken)
    ) {
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer')
        .send({ status: 'unauthorized' });
    }

    if (!options.db) {
      return reply.code(503).send({ status: 'unavailable' });
    }

    try {
      return await getOperationalMetrics(options.db);
    } catch (error) {
      app.log.error({ err: error }, 'operational metrics query failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.post('/viber/webhook', createViberWebhookHandler(options));

  return app;
}

function isAuthorized(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorization) return false;

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match?.[1]) return false;

  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}
