import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

const valid = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/gatekeeper',
  JWT_SECRET: 'x'.repeat(48),
};

describe('loadEnv', () => {
  it('applies defaults and coerces numbers', () => {
    const env = loadEnv({ ...valid, PORT: '8080' });
    expect(env).toMatchObject({ NODE_ENV: 'development', PORT: 8080, COVERAGE_RATIO_FLAG: 3, DUPLICATE_WINDOW_HOURS: 48, LOOKBACK_DAYS: 7 });
  });

  it('refuses to start without a JWT secret', () => {
    expect(() => loadEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrow(/JWT_SECRET/);
  });

  it('rejects a weak secret without echoing its value', () => {
    const attempt = () => loadEnv({ ...valid, JWT_SECRET: 'hunter2' });
    expect(attempt).toThrow(/JWT_SECRET: must be at least 32 characters/);
    expect(attempt).not.toThrow(/hunter2/);
  });

  it('rejects a malformed database URL and an out-of-range port', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ ...valid, PORT: '70000' })).toThrow(/PORT/);
  });
});
