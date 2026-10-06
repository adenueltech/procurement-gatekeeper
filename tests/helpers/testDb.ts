import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';

// PGlite is PostgreSQL compiled to WebAssembly, so the tests run the real engine
// (transactions, row locks, constraints, jsonb) without needing a database server.
// It takes a few seconds to boot, so one instance is shared and emptied between tests.
let shared: Promise<PGlite> | undefined;

function boot(): Promise<PGlite> {
  shared ??= (async () => {
    const db = new PGlite();
    await db.exec(readFileSync(join(__dirname, '../../migrations/001_init.sql'), 'utf8'));
    return db;
  })();
  return shared;
}

/**
 * Presents the single PGlite connection through the part of pg's Pool interface the service uses.
 * A checked-out client holds the connection until it is released, as a real pooled client would.
 */
function asPool(db: PGlite): Pool {
  let tail: Promise<unknown> = Promise.resolve();
  const acquire = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const ready = tail.then(() => release);
    tail = tail.then(() => held);
    return ready;
  };
  const run = async (text: string, values?: unknown[]) => {
    const result = await db.query(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  return {
    async connect() {
      const release = await acquire();
      return { query: run, release };
    },
    async query(text: string, values?: unknown[]) {
      const release = await acquire();
      try {
        return await run(text, values);
      } finally {
        release();
      }
    },
  } as unknown as Pool;
}

/** An empty database with the real migration applied. */
export async function createTestDb() {
  const db = await boot();
  await db.exec('TRUNCATE outbox, audit_log, procurement_requests, demand_baselines RESTART IDENTITY CASCADE');
  const pool = asPool(db);

  return {
    pool,
    async seedBaseline(regionId: string, sku: string, median: number, mad: number) {
      await pool.query(
        'INSERT INTO demand_baselines (region_id, sku, median_units, mad_units, updated_at) VALUES ($1, $2, $3, $4, $5)',
        [regionId, sku, median, mad, new Date('2026-10-01T00:00:00Z')],
      );
    },
    async count(table: 'procurement_requests' | 'audit_log' | 'outbox') {
      const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
      return Number(rows[0].n);
    },
  };
}
