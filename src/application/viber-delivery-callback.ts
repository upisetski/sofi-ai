import { withTransaction, type Db } from '../db/client.js';

export interface ViberDeliveryCallback {
  event: 'delivered' | 'seen' | 'failed';
  timestamp: number;
  message_token: string;
  user_id: string;
}

export async function recordViberDeliveryCallback(
  db: Db,
  callback: ViberDeliveryCallback,
): Promise<{ matched: boolean }> {
  return withTransaction(db, async (client) => {
    const stored = await client.query<{
      user_id: string;
      event_type: ViberDeliveryCallback['event'];
      occurred_at: Date;
    }>(
      `INSERT INTO viber_delivery_callbacks (
         message_token, user_id, event_type, occurred_at
       )
       VALUES ($1, $2, $3, TO_TIMESTAMP($4 / 1000.0))
       ON CONFLICT (message_token)
       DO UPDATE SET
         event_type = CASE
           WHEN viber_delivery_callbacks.event_type IN ('delivered', 'seen')
             THEN viber_delivery_callbacks.event_type
           WHEN EXCLUDED.event_type IN ('delivered', 'seen')
             THEN EXCLUDED.event_type
           ELSE EXCLUDED.event_type
         END,
         occurred_at = GREATEST(
           viber_delivery_callbacks.occurred_at,
           EXCLUDED.occurred_at
         )
       RETURNING user_id, event_type, occurred_at`,
      [
        callback.message_token,
        callback.user_id,
        callback.event,
        callback.timestamp,
      ],
    );

    const persisted = stored.rows[0];
    if (!persisted)
      throw new Error('Failed to persist Viber delivery callback');

    const update = await client.query(
      `UPDATE conversation_turns t
       SET delivery_status = CASE
             WHEN $3 IN ('delivered', 'seen') THEN 'delivered'
             WHEN t.delivery_status = 'delivered' THEN 'delivered'
             ELSE 'terminal_failure'
           END,
           delivered_at = CASE
             WHEN $3 IN ('delivered', 'seen')
               THEN COALESCE(t.delivered_at, $4)
             ELSE t.delivered_at
           END,
           failure_stage = CASE
             WHEN $3 IN ('delivered', 'seen') THEN
               CASE WHEN t.generation_status = 'failed' THEN 'generation' ELSE NULL END
             WHEN t.delivery_status = 'delivered' THEN NULL
             ELSE 'delivery'
           END,
           last_error_category = CASE
             WHEN $3 IN ('delivered', 'seen') THEN
               CASE WHEN t.generation_status = 'failed' THEN t.last_error_category ELSE NULL END
             WHEN t.delivery_status = 'delivered' THEN NULL
             ELSE 'viber_failed_callback'
           END,
           updated_at = NOW()
       FROM conversations c
       JOIN users u ON u.id = c.user_id
       WHERE t.conversation_id = c.id
         AND t.viber_message_token = $1
         AND u.provider_user_id = $2
         AND t.delivery_status <> 'delivered'`,
      [
        callback.message_token,
        persisted.user_id,
        persisted.event_type,
        persisted.occurred_at,
      ],
    );

    return { matched: (update.rowCount ?? 0) > 0 };
  });
}
