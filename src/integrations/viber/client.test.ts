import { describe, expect, it, vi } from 'vitest';

import { createViberClient, ViberSendError } from './client.js';

describe('Viber client', () => {
  it('returns a lossless message token for delivery callback correlation', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"status":0,"message_token":9007199254740993123}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createViberClient({
      authToken: 'test-viber-token',
      fetchImpl,
    });

    await expect(
      client.sendTextMessage({
        receiver: 'user-1',
        senderName: 'Sofi',
        text: 'A safe test reply',
      }),
    ).resolves.toEqual({ messageToken: '9007199254740993123' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://chatapi.viber.com/pa/send_message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Viber-Auth-Token': 'test-viber-token',
        }),
      }),
    );
  });

  it('classifies transient HTTP and Viber rate-limit errors as retryable', async () => {
    const httpClient = createViberClient({
      authToken: 'token',
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('', { status: 503 })),
    });

    await expect(
      httpClient.sendTextMessage({
        receiver: 'u',
        senderName: 'Sofi',
        text: 'reply',
      }),
    ).rejects.toMatchObject({
      name: 'ViberSendError',
      category: 'http_retryable',
      retryable: true,
      httpStatus: 503,
    });

    const rateLimitClient = createViberClient({
      authToken: 'token',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{"status":12,"status_message":"too many requests"}', {
          status: 200,
        }),
      ),
    });

    await expect(
      rateLimitClient.sendTextMessage({
        receiver: 'u',
        senderName: 'Sofi',
        text: 'reply',
      }),
    ).rejects.toMatchObject({
      category: 'rate_limited',
      retryable: true,
    });
  });

  it('marks permanent API rejections terminal without exposing raw response text', async () => {
    const client = createViberClient({
      authToken: 'token',
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            '{"status":2,"status_message":"bad credentials and private input"}',
            { status: 200 },
          ),
        ),
    });

    let thrown: unknown;
    try {
      await client.sendTextMessage({
        receiver: 'u',
        senderName: 'Sofi',
        text: 'reply',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ViberSendError);
    expect(thrown).toMatchObject({
      category: 'api_rejected',
      retryable: false,
    });
    expect((thrown as Error).message).not.toContain('private input');
  });

  it('treats network failures as ambiguous and retryable without logging content', async () => {
    const client = createViberClient({
      authToken: 'token',
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('network error included private input')),
    });

    await expect(
      client.sendTextMessage({
        receiver: 'u',
        senderName: 'Sofi',
        text: 'private input',
      }),
    ).rejects.toMatchObject({
      category: 'network',
      retryable: true,
    });
  });
});
