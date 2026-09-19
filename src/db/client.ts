import { Pool, type PoolClient } from 'pg';

export type Db = Pool;

export function createDb(databaseUrl = process.env.DATABASE_URL): Pool {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for database operations');
  }

  return new Pool({
    connectionString: databaseUrl,
    max: process.env.NODE_ENV === 'test' ? 4 : 10,
  });
}

export async function withTransaction<T>(
  db: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
