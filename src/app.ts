import Fastify from 'fastify';
import helmet from '@fastify/helmet';

export function buildApp() {
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

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/viber/webhook', async () => ({ ok: true }));

  return app;
}
