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
  getAiLimitReachedResponse,
  getAiTemporaryErrorResponse,
  getContextResetConfirmation,
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
    'TRUNCATE jobs, viber_delivery_callbacks, conversation_turns, messages, conversation_events, conversations, users RESTART IDENTITY CASCADE',
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

  it('returns distinct, localized messages for exhausted budgets', () => {
    expect(getAiLimitReachedResponse('en', 'user_daily_budget').text).toBe(
      'I’ve reached your daily reply allowance 🙂 Come back after the daily reset and we’ll pick up where we left off.',
    );
    expect(getAiLimitReachedResponse('en', 'request_rate_limit').text).toBe(
      'I’ve reached your daily reply allowance 🙂 Come back after the daily reset and we’ll pick up where we left off.',
    );
    expect(getAiLimitReachedResponse('en', 'global_daily_budget').text).toBe(
      'I’ve reached today’s shared reply limit. Please try again after the daily reset 🙂',
    );
    expect(getAiLimitReachedResponse('en', 'global_monthly_budget').text).toBe(
      'I’m temporarily unable to take new requests because the service has reached its limit. Please try again later — we’ll pick up where we left off.',
    );
    expect(getAiLimitReachedResponse('en', 'pricing_unavailable').text).toBe(
      getAiTemporaryErrorResponse('en').text,
    );
    expect(getAiLimitReachedResponse('ru', 'user_daily_budget').text).toContain(
      'обновления лимита',
    );
    expect(
      getAiLimitReachedResponse('be', 'global_daily_budget').text,
    ).toContain('абнаўлення ліміту');
  });

  it('localizes both sender name and welcome text', () => {
    expect(getWelcome('ru').senderName).toBe('Софи - AI-помощница');
    expect(getWelcome('be').senderName).toBe('Сафі - AI-памочніца');
    expect(getWelcome('en').senderName).toBe('Sofi - AI assistant');
    expect(getWelcomeText('ru')).toContain('Я Софи');
    expect(getWelcomeText('be')).toContain('Я Сафі');
    expect(getWelcomeText('en')).toContain('Sofi');
    expect(getAiTemporaryErrorResponse('ru').text).toBe(
      'Сейчас не получается подготовить ответ. Попробуйте ещё раз чуть позже.',
    );
    expect(getAiTemporaryErrorResponse('be').text).toBe(
      'Зараз не атрымліваецца падрыхтаваць адказ. Паспрабуйце яшчэ раз крыху пазней.',
    );
    expect(getAiTemporaryErrorResponse('en').text).toBe(
      'I can’t prepare a response right now. Please try again shortly.',
    );
    expect(getContextResetConfirmation('ru').text).toBe(
      'Контекст разговора очищен. Начнём заново.',
    );
    expect(getContextResetConfirmation('be').text).toBe(
      'Кантэкст размовы ачышчаны. Пачнём нанова.',
    );
    expect(getContextResetConfirmation('en').text).toBe(
      'Conversation context cleared. Let’s start fresh.',
    );
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
    const body =
      '{"event":"webhook","timestamp":1457764197627,"message_token":5741311803571721087}';

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

  it('acknowledges the Viber availability callback without database processing', async () => {
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
        'x-viber-content-signature': sign(body),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it.skipIf(!databaseUrl)(
    'persists Viber delivery callback metadata without storing the description',
    async () => {
      process.env.VIBER_AUTH_TOKEN = authToken;
      const app = buildApp({ db: requireTestDb() });
      const body = JSON.stringify({
        event: 'failed',
        timestamp: 1457764197627,
        message_token: 241256543218,
        user_id: '01234567890A==',
        desc: 'private delivery diagnostic that must not persist',
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
      const callbacks = await requireTestDb().query(
        'SELECT message_token, event_type FROM viber_delivery_callbacks',
      );
      expect(callbacks.rows).toEqual([
        { message_token: '241256543218', event_type: 'failed' },
      ]);
      expect(JSON.stringify(callbacks.rows)).not.toContain(
        'private delivery diagnostic',
      );

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
    'bypasses a pending text debounce when a context reset command arrives',
    async () => {
      process.env.VIBER_AUTH_TOKEN = authToken;
      const app = buildApp({
        db: requireTestDb(),
        reorderDelayMs: 1000,
        messageDebounceMs: 5000,
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
      const firstResponse = await app.inject({
        method: 'POST',
        url: '/viber/webhook',
        headers: {
          'content-type': 'application/json',
          'x-viber-content-signature': sign(firstBody),
        },
        payload: firstBody,
      });
      expect(firstResponse.statusCode).toBe(200);

      const initialJob = await requireTestDb().query<{ available_at: Date }>(
        'SELECT available_at FROM jobs WHERE type = $1',
        ['process_conversation'],
      );
      const initialDeadline = initialJob.rows[0]?.available_at.getTime();
      expect(initialDeadline).toBeDefined();
      if (initialDeadline === undefined) {
        throw new Error('Expected a pending conversation job');
      }
      expect(initialDeadline).toBeGreaterThan(Date.now() + 3000);

      const resetBody = JSON.stringify({
        event: 'message',
        timestamp: 1457764198627,
        message_token: 241256543218,
        sender: {
          id: '01234567890A==',
          language: 'be',
        },
        message: {
          type: 'text',
          text: '/reset',
        },
      });
      const resetResponse = await app.inject({
        method: 'POST',
        url: '/viber/webhook',
        headers: {
          'content-type': 'application/json',
          'x-viber-content-signature': sign(resetBody),
        },
        payload: resetBody,
      });
      expect(resetResponse.statusCode).toBe(200);

      const resetJob = await requireTestDb().query<{ available_at: Date }>(
        'SELECT available_at FROM jobs WHERE type = $1',
        ['process_conversation'],
      );
      const resetDeadline = resetJob.rows[0]?.available_at.getTime();
      expect(resetDeadline).toBeDefined();
      if (resetDeadline === undefined) {
        throw new Error(
          'Expected the reset command to keep a conversation job',
        );
      }
      expect(resetDeadline).toBeLessThan(initialDeadline - 3000);
      expect(resetDeadline).toBeGreaterThan(Date.now() + 500);
      expect(resetDeadline).toBeLessThanOrEqual(Date.now() + 1500);

      await app.close();
    },
  );

  it.skipIf(!databaseUrl)(
    'does not respond immediately to rapid messages',
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
        messageDebounceMs: 5000,
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
      expect(fetchMock).not.toHaveBeenCalled();

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
      const body =
        '{"event":"subscribed","timestamp":1457764197627,"message_token":5741311803571721087,"user":{"id":"01234567890A==","language":"be"}}';

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
    'deduplicates an already accepted callback without responding',
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
      expect(fetchMock).not.toHaveBeenCalled();

      const events = await requireTestDb().query(
        'SELECT id FROM conversation_events',
      );
      expect(events.rowCount).toBe(1);

      vi.unstubAllGlobals();
      await app.close();
    },
  );
});
