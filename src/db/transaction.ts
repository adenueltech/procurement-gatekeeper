import type { Pool, PoolClient } from 'pg';

/**
 * Runs `work` inside one database transaction.
 * Any error rolls the whole transaction back and is rethrown; the client is always released.
 */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the original error is the one worth reporting.
    }
    throw error;
  } finally {
    client.release();
  }
}

const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;
}
