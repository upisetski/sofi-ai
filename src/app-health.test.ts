import { describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';
import type { Db } from './db/client.js';

function createDbMock(queryResult: unknown): Db {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
  } as unknown as Db;
}

describe('health readiness', () => {
  it('returns ok when PostgreSQL is reachable', async () => {
    const db = createDbMock({ rows: [{ '?column?': 1 }] });
    const app = buildApp({ db });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(db.query).toHaveBeenCalledWith('SELECT 1');

    await app.close();
  });

  it('returns 503 when PostgreSQL is unavailable', async () => {
    const db = {
      query: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as Db;
    const app = buildApp({ db });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready' });

    await app.close();
  });
});
