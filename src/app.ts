import Fastify from 'fastify';
import helmet from '@fastify/helmet';

export function buildApp() {
  const app = Fastify({
    logger: {
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : {
              target: 'pino-pretty',
              options: { colorize: true },
            },
    },
  });

  app.register(helmet);

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/viber/webhook', async () => ({ ok: true }));

  return app;
}
