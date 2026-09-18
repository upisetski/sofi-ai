import { createHmac } from 'node:crypto';

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';
import {
  getWelcome,
  getWelcomeText,
  resolveLocale,
} from './localization/index.js';
import { createDb, type Db } from './db/client.js';
import { migrate } from './db/migrations.js';

const authToken = 'test-viber-auth-token';
const databaseUrl = process.env.DATABASE_URL;
let db: Db | undefined;

function sign(body: string): string {
  return createHmac('sha256', authToken).update(body).digest('hex');
}

beforeAll(async () => {
  if (!databaseUrl) return;
  db = createDb(databaseUrl);
  await migrate(db);
});

beforeEach(async () => {
  if (!db) return;
  await db.query(
    'TRUNCATE jobs, messages, conversation_events, conversations, users RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await db?.end();
});

describe('health', () => {
  it('returns ok', async () => {
    const app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });
});

describe('localization', () => {
  it('supports Russian, Belarusian, and English', () => {
    expect(resolveLocale('ru')).toBe('ru');
    expect(resolveLocale('be')).toBe('be');
    expect(resolveLocale('en')).toBe('en');
  });

  it('falls back to Russian', () => {
    expect(resolveLocale(undefined)).toBe('ru');
    expect(resolveLocale('de')).toBe('ru');
  });

  it('localizes both sender name and welcome text', () => {
    expect(getWelcome('ru').senderName).toBe('Софи - AI-помощница');
    expect(getWelcome('be').senderName).toBe('Сафі - AI-памочніца');
    expect(getWelcome('en').senderName).toBe('Sofi - AI assistant');
    expect(getWelcomeText('ru')).toContain('Я Софи');
    expect(getWelcomeText('be')).toContain('Я Сафі');
    expect(getWelcomeText('en')).toContain('Sofi');
  });
});

describe('Viber webhook', () => {
  it('returns 400 for an invalid signature', async () => {
    process.env.VIBER_AUTH_TOKEN = authToken;
    const app = buildApp();

    const body = JSON.stringify({
      event: 'webhook',
      timestamp: 1457764197627,
      message_token: 241256543215,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/viber/webhook',
      headers: {
        'content-type': 'application/json',
        'x-viber-content-signature': 'invalid',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('');

    await app.close();
  });

  it.skipIf(!databaseUrl)(
    'persists conversation_started before returning success',
    async () => {
      process.env.VIBER_AUTH_TOKEN = authToken;
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 0, status_message: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const app = buildApp({ db });

      const body = JSON.stringify({
        event: 'conversation_started',
        timestamp: 1457764197627,
        message_token: 241256543215,
        type: 'open',
        user: {
          id: '01234567890A==',
          language: 'be',
        },
        subscribed: false,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/viber/webhook',
        headers: {
          'content-type': 'application/json',
          'x-viber-content-signature': sign(body),
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('');

      const eventResult = await db!.query(
        'SELECT event_type FROM conversation_events',
      );
      expect(eventResult.rows).toEqual([{ event_type: 'conversation_started' }]);

      const jobResult = await db!.query(
        'SELECT status FROM jobs WHERE type = $1',
        ['process_conversation'],
      );
      expect(jobResult.rows).toEqual([{ status: 'pending' }]);

      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
      await app.close();
    },
  );

  it.skipIf(!databaseUrl)(
    'deduplicates an already accepted callback',
    async () => {
      process.env.VIBER_AUTH_TOKEN = authToken;
      const app = buildApp({ db });

      const body = JSON.stringify({
        event: 'message',
        timestamp: 1457764197627,
        message_token: 241256543216,
        sender: {
          id: '01234567890A==',
          language: 'be',
        },
        message: {
          type: 'text',
          text: 'hello',
        },
      });

      const headers = {
        'content-type': 'application/json',
        'x-viber-content-signature': sign(body),
      };

      const first = await app.inject({
        method: 'POST',
        url: '/viber/webhook',
        headers,
        payload: body,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/viber/webhook',
        headers,
        payload: body,
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      const events = await db!.query('SELECT id FROM conversation_events');
      expect(events.rowCount).toBe(1);

      await app.close();
    },
  );
});
