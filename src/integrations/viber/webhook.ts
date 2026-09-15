import { createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { welcomeMessage } from './welcome.js';
import { viberCallbackSchema } from './schemas.js';

const signatureHeader = 'x-viber-content-signature';

export function verifyViberSignature(
  body: string,
  signature: string | undefined,
  authToken: string,
): boolean {
  if (!signature) {
    return false;
  }

  const expected = createHmac('sha256', authToken).update(body).digest('hex');
  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export async function handleViberWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authToken = process.env.VIBER_AUTH_TOKEN;
  const signature = request.headers[signatureHeader];
  const body = typeof request.body === 'string' ? request.body : null;

  if (!authToken || !body) {
    request.log.error('Viber webhook is not configured to accept callbacks');
    await reply.code(500).send();
    return;
  }

  if (
    !verifyViberSignature(
      body,
      typeof signature === 'string' ? signature : undefined,
      authToken,
    )
  ) {
    request.log.warn('Invalid Viber webhook signature');
    await reply.code(400).send();
    return;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(body);
  } catch (error) {
    request.log.warn(
      { error: error instanceof Error ? error.message : 'unknown error' },
      'Invalid Viber webhook JSON',
    );
    await reply.code(400).send();
    return;
  }

  const result = viberCallbackSchema.safeParse(payload);

  if (!result.success) {
    request.log.warn(
      {
        issues: result.error.issues.map(({ code, message, path }) => ({
          code,
          message,
          path,
        })),
      },
      'Invalid Viber webhook payload',
    );
    await reply.code(400).send();
    return;
  }

  try {
    request.log.debug({ event: result.data.event }, 'Viber webhook received');

    if (result.data.event === 'conversation_started') {
      await reply.code(200).send(welcomeMessage);
      return;
    }

    await reply.code(200).send();
  } catch (error) {
    request.log.error(error, 'Failed to acknowledge Viber webhook');
    await reply.code(500).send();
  }
}
