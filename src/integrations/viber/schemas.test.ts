import { describe, expect, it } from 'vitest';

import { viberCallbackSchema, viberMessageSchema } from './schemas.js';

describe('Viber callback schemas', () => {
  it.each([
    [
      'webhook',
      {
        event: 'webhook',
        timestamp: 1457764197627,
        message_token: '241256543215',
      },
    ],
    [
      'delivered',
      {
        event: 'delivered',
        timestamp: 1457764197627,
        message_token: '491266184665523145',
        user_id: '01234567890A=',
      },
    ],
    [
      'seen',
      {
        event: 'seen',
        timestamp: 1457764197627,
        message_token: '491266184665523145',
        user_id: '01234567890A=',
      },
    ],
    [
      'failed',
      {
        event: 'failed',
        timestamp: 1457764197627,
        message_token: '491266184665523145',
        user_id: '01234567890A=',
        desc: 'failure description',
      },
    ],
    [
      'subscribed',
      {
        event: 'subscribed',
        timestamp: 1457764197627,
        message_token: '491266184665523145',
        user: {
          id: '01234567890A=',
          name: 'John McClane',
          avatar: 'https://avatar.example.com',
          country: 'UK',
          language: 'en',
          api_version: 1,
        },
      },
    ],
    [
      'unsubscribed',
      {
        event: 'unsubscribed',
        timestamp: 1457764197627,
        user_id: '01234567890A=',
        message_token: '491266184665523145',
      },
    ],
    [
      'conversation_started',
      {
        event: 'conversation_started',
        timestamp: 1457764197627,
        message_token: '491266184665523145',
        type: 'open',
        context: 'context information',
        user: {
          id: '01234567890A=',
          name: 'John McClane',
          avatar: 'https://avatar.example.com',
          country: 'UK',
          language: 'en',
          api_version: 1,
        },
        subscribed: false,
      },
    ],
    [
      'message',
      {
        event: 'message',
        timestamp: 1457764197627,
        message_token: '491266184665523145',
        sender: {
          id: '01234567890A=',
          name: 'John McClane',
          avatar: 'https://avatar.example.com',
          country: 'UK',
          language: 'en',
          api_version: 1,
        },
        message: {
          type: 'text',
          text: 'a message to the service',
          tracking_data: 'tracking data',
        },
      },
    ],
  ])('accepts the %s callback', (_event, payload) => {
    expect(viberCallbackSchema.safeParse(payload).success).toBe(true);
  });

  it.each([
    { type: 'text', text: 'hello' },
    {
      type: 'picture',
      text: 'a photo',
      media: 'https://example.com/image.jpg',
    },
    {
      type: 'video',
      media: 'https://example.com/video.mp4',
      size: 10000,
      duration: 10,
    },
    {
      type: 'file',
      media: 'https://example.com/file.pdf',
      file_name: 'file.pdf',
      file_size: 10000,
    },
    { type: 'sticker', sticker_id: 46105 },
    {
      type: 'contact',
      contact: {
        name: 'Itamar',
        phone_number: '+972511123123',
      },
    },
    {
      type: 'location',
      location: {
        lat: 50.76891,
        lon: 6.11499,
      },
    },
    {
      type: 'url',
      media: 'https://www.example.com/go_here',
    },
  ])('accepts a %s message payload', (payload) => {
    expect(viberMessageSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects an unknown callback event', () => {
    expect(
      viberCallbackSchema.safeParse({
        event: 'unknown',
        timestamp: 1457764197627,
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid message discriminator', () => {
    expect(
      viberMessageSchema.safeParse({
        type: 'audio',
      }).success,
    ).toBe(false);
  });
});
