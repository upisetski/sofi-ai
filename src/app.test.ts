import { createHmac } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { buildApp } from './app.js';
import { createDb, type Db } from './db/client.js';
import { migrate } from './db/migrations.js';
import {
  getThinking,
  getWelcome,
  getWelcomeText,
  resolveLocale,
} from './localization/index.js';

const authToken = 'test-viber-auth-token';
const databaseUrl = process.env.DATABASE_URL;
let db: Db | undefined;

function sign(body: string): string {
  return createHmac('sha256', authToken).update(body).digest('hex');
}

function requireTestDb(): Db {
  if (!db) {
    throw new Error('DATABASE_URL is required for this test');
  }

  return db;
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
    expect(getThinking('ru', 'hello').thinking).toBe(
      'Думаю над твоим сообщением:\n\nhello',
    );
    expect(getThinking('be', 'hello').thinking).toBe(
      'Думаю над тваім паведамленнем:\n\nhello',
    );
    expect(getThinking('en', 'hello').thinking).toBe(
      'Thinking about your message:\n\nhello',
    );

    const longMessage = getThinking('en', '🙂'.repeat(1001)).thinking;
    expect([
      ...longMessage.slice('Thinking about your message:\n\n'.length),
    ]).toHaveLength(1000);
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

  it('accepts Viber webhook availability callback with a long message token', async () => {
    process.env.VIBER_AUTH_TOKEN = authToken;
    const app = buildApp();
    const body = JSON.stringify({
      event: 'webhook',
      timestamp: 1457764197627,
      message_token: 241256543215,
    }).replace(
      '241256543215',
      '5741311803571721087',
    );

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

    await app.close();
  });

  it.each([
    [
      'webhook',
      {
        event: 'webhook',
        timestamp: 1457764197627,
        message_token: 241256543215,
      },
    ],
    [
      'delivered',
      {
        event: 'delivered',
        timestamp: 1457764197627,
        message_token: 241256543216,
        user_id: '01234567890A==',
      },
    ],
    [
      'seen',
      {
        event: 'seen',
        timestamp: 1457764197627,
        message_token: 241256543217,
        user_id: '01234567890A==',
      },
    ],
    [
      'failed',
      {
        event: 'failed',
        timestamp: 1457764197627,
        message_token: 241256543218,
        user_id: '01234567890A==',
        desc: 'failure description',
      },
    ],
  ])(
    'acknowledges the %s callback without database processing',
    async (_event, payload) => {
      process.env.VIBER_AUTH_TOKEN = authToken;
      const app = buildApp();

      const body = JSON.stringify(payload);
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

      await app.close();
    },
  );

  it.skipIf(!databaseUrl)(
    'sends a localized welcome for conversation_started',
    async () => {
      process.env.VIBER_AUTH_TOKEN = authToken;
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 0, status_message: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const app = buildApp({ db: requireTestDb() });
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

      const request = fetchMock.mock.calls[0];
      expect(request?.[0]).toBe('https://chatapi.viber.com/pa/send_message');
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({
        receiver: '01234567890A==',
        sender: { name: getWelcome('be').senderName },
        type: 'text',
        text: getWelcome('be').welcome,
      });

      vi.unstubAllGlobals();
      await app.close();
    },
  );

  it.skipIf(!databaseUrl)(
    'sends one localized thinking acknowledgement for rapid messages',
    async () => {
      process.env.VIBER_AUTH_TOKEN = authToken;
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 0, status_message: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const app = buildApp({
        db: requireTestDb(),
        reorderDelayMs: 0,
        messageDebounceMs: 1500,
      });

      const firstBody = JSON.stringify({
        event: 'message',
        timestamp: 1457764197627,
        message_token: 241256543217,
        sender: {
          id: '01234567890A==',
          language: 'be',
        },
        message: {
          type: 'text',
          text: 'hello',
        },
      });

      const secondBody = JSON.stringify({
        event: 'message',
        timestamp: 1457764198627,
        message_token: 241256543218,
        sender: {
          id: '01234567890A==',
          language: 'be',
        },
        message: {
          type: 'text',
          text: 'how are you?',
        },
      });

      const first = await app.inject({
        method: 'POST',
        url: '/viber/webhook',
        headers: {
          'content-type': 'application/json',
          'x-viber-content-signature': sign(firstBody),
        },
        payload: firstBody,
      });

      const second = await app.inject({
        method: 'POST',
        url: '/viber/webhook',
        headers: {
          'content-type': 'application/json',
          'x-viber-content-signature': sign(secondBody),
        },
        payload: secondBody,
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const request = fetchMock.mock.calls[0];
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({
        receiver: '01234567890A==',
        sender: { name: getThinking('be', 'hello').senderName },
        type: 'text',
        text: getThinking('be', 'hello').thinking,
      });

      vi.unstubAllGlobals();
      await app.close();
    },
  );

  it.skipIf(!databaseUrl)(
    'parses and validates a signed callback and returns 200',
    async () => {
      process.env.VIBER_AUTH_TOKEN = authToken;
      const app = buildApp({
        db: requireTestDb(),
      });
      const body = JSON.stringify({
        event: 'subscribed',
        timestamp: 1457764197627,
        user: {
          id: '01234567890A==',
          language: 'be',
        },
      }).replace(
        '"user"',
        '"message_token":5741311803571721087,"user"',
      );

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

      const eventResult = await requireTestDb().query(
        'SELECT provider_event_id FROM conversation_events',
      );
      expect(eventResult.rows).toEqual([
        { provider_event_id: '5741311803571721087' },
      ]);

      await app.close();
    },
  );

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

      const app = buildApp({
        db: requireTestDb(),
      });

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

      const eventResult = await requireTestDb().query(
        'SELECT event_type FROM conversation_events',
      );
      expect(eventResult.rows).toEqual([
        { event_type: 'conversation_started' },
      ]);

      const jobResult = await requireTestDb().query(
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
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 0, status_message: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const app = buildApp({
        db: requireTestDb(),
      });

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
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const events = await requireTestDb().query(
        'SELECT id FROM conversation_events',
      );
      expect(events.rowCount).toBe(1);

      vi.unstubAllGlobals();
      await app.close();
    },
  );
});
