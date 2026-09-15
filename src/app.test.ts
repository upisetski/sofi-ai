import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';
import { getWelcome, getWelcomeText, resolveLocale } from './localization/index.js';

const authToken = 'test-viber-auth-token';

function sign(body: string): string {
  return createHmac('sha256', authToken).update(body).digest('hex');
}

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

  it('sends a localized welcome for conversation_started', async () => {
    process.env.VIBER_AUTH_TOKEN = authToken;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 0, status_message: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const app = buildApp();
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
  });

  it('parses and validates a signed callback and returns 200', async () => {
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
    expect(response.body).toBe('');

    await app.close();
  });
});
