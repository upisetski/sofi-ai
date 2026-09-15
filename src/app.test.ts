import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

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

  it('returns 400 for an invalid payload', async () => {
    process.env.VIBER_AUTH_TOKEN = authToken;
    const app = buildApp();
    const body = JSON.stringify({
      event: 'unknown',
      timestamp: 1457764197627,
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

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('');

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
