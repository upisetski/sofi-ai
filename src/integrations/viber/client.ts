export interface ViberSendResult {
  messageToken?: string;
}

export interface ViberClient {
  sendTextMessage(input: {
    receiver: string;
    senderName: string;
    text: string;
  }): Promise<ViberSendResult>;
}

export class ViberSendError extends Error {
  readonly category: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly providerStatus?: number;

  constructor(
    category: string,
    retryable: boolean,
    httpStatus?: number,
    providerStatus?: number,
  ) {
    super(`Viber send_message failed: ${category}`);
    this.name = 'ViberSendError';
    this.category = category;
    this.retryable = retryable;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (providerStatus !== undefined) this.providerStatus = providerStatus;
  }
}

/**
 * message_token may exceed Number.MAX_SAFE_INTEGER. Preserve it as text so
 * the outbound response can be correlated with Viber delivery callbacks.
 */
function parseSendResponse(raw: string): unknown {
  const normalized = raw.replace(
    /("message_token"\s*:\s*)(\d+)(?=\s*[,}])/g,
    '$1"$2"',
  );
  return JSON.parse(normalized);
}

export function createViberClient(input: {
  authToken: string;
  fetchImpl?: typeof fetch;
}): ViberClient {
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async sendTextMessage({ receiver, senderName, text }) {
      let response: Response;
      try {
        response = await fetchImpl(
          'https://chatapi.viber.com/pa/send_message',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Viber-Auth-Token': input.authToken,
            },
            body: JSON.stringify({
              receiver,
              sender: { name: senderName },
              type: 'text',
              text,
            }),
          },
        );
      } catch {
        // Request outcome can be ambiguous if the remote side accepted it.
        throw new ViberSendError('network', true);
      }

      if (!response.ok) {
        const retryable =
          response.status === 429 || response.status >= 500;
        throw new ViberSendError(
          retryable ? 'http_retryable' : 'http_terminal',
          retryable,
          response.status,
        );
      }

      let payload: unknown;
      try {
        payload = parseSendResponse(await response.text());
      } catch {
        // A malformed/lost response may still mean the message was accepted.
        throw new ViberSendError('invalid_response', true);
      }

      if (!payload || typeof payload !== 'object') {
        throw new ViberSendError('invalid_response', true);
      }

      const result = payload as {
        status?: unknown;
        message_token?: unknown;
      };

      if (typeof result.status !== 'number') {
        throw new ViberSendError('invalid_response', true);
      }

      if (result.status !== 0) {
        const retryable = result.status === 12;
        throw new ViberSendError(
          retryable ? 'rate_limited' : 'api_rejected',
          retryable,
          undefined,
          result.status,
        );
      }

      return {
        ...(typeof result.message_token === 'string'
          ? { messageToken: result.message_token }
          : typeof result.message_token === 'number' &&
              Number.isSafeInteger(result.message_token)
            ? { messageToken: String(result.message_token) }
            : {}),
      };
    },
  };
}
