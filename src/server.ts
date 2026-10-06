import 'dotenv/config';
import { Pool } from 'pg';
import { loadEnv } from './config/env';
import { DEFAULT_POLICY } from './domain/riskEngine';
import { createApp } from './http/app';
import { GatekeeperService } from './services/gatekeeperService';

const env = loadEnv();
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });

const service = new GatekeeperService(pool, {
  policy: { ...DEFAULT_POLICY, coverageRatioFlag: env.COVERAGE_RATIO_FLAG },
  lookbackDays: env.LOOKBACK_DAYS,
  duplicateWindowHours: env.DUPLICATE_WINDOW_HOURS,
});

const server = createApp({ service, jwtSecret: env.JWT_SECRET }).listen(env.PORT, () => {
  console.log(`procurement-gatekeeper listening on port ${env.PORT}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
