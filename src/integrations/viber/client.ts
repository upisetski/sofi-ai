export interface ViberClient {
  sendTextMessage(input: {
    receiver: string;
    senderName: string;
    text: string;
  }): Promise<void>;
}

export function createViberClient(input: { authToken: string }): ViberClient {
  return {
    async sendTextMessage({ receiver, senderName, text }) {
      const response = await fetch(
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

      if (!response.ok) {
        throw new Error(
          'Viber send_message failed with HTTP ' + response.status,
        );
      }

      const payload = (await response.json()) as {
        status?: number;
        status_message?: string;
      };

      if (payload.status !== 0) {
        throw new Error(
          'Viber send_message failed: ' +
            (payload.status_message ?? 'unknown error'),
        );
      }
    },
  };
}
