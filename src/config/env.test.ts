import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

const baseEnv = {
  VIBER_AUTH_TOKEN: 'test-viber-auth-token',
};

describe('environment configuration', () => {
  it('allows DATABASE_URL to be omitted outside production', () => {
    expect(parseEnv({ ...baseEnv, NODE_ENV: 'test' }).DATABASE_URL).toBeUndefined();
  });

  it('requires DATABASE_URL in production', () => {
    expect(() => parseEnv({ ...baseEnv, NODE_ENV: 'production' })).toThrow(
      /DATABASE_URL is required in production/,
    );
  });

  it('accepts DATABASE_URL in production', () => {
    expect(
      parseEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:password@host:5432/db',
      }).DATABASE_URL,
    ).toBe('postgresql://user:password@host:5432/db');
  });
});
