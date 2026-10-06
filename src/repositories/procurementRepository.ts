import type { Reason, RiskLevel } from '../domain/riskEngine';

/** The subset of pg's Pool / PoolClient the repository needs. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export type RequestStatus = 'APPROVED' | 'APPROVED_TAGGED' | 'ON_HOLD' | 'RELEASED' | 'REJECTED';

export interface ProcurementRequest {
  id: string;
  regionId: string;
  sku: string;
  requesterId: string;
  quantity: number;
  status: RequestStatus;
  riskScore: number;
  riskLevel: RiskLevel;
  reasons: Reason[];
  idempotencyKey: string;
  payloadHash: string;
  decidedBy: string | null;
  createdAt: Date;
}

export interface Baseline {
  median: number;
  mad: number;
}

export interface WindowAggregates {
  openQuantity: number;
  duplicateCount: number;
  requesterCount: number;
}

const COLUMNS = `id, region_id, sku, requester_id, quantity, status, risk_score, risk_level,
  reasons, idempotency_key, payload_hash, decided_by, created_at`;

function toRequest(row: any): ProcurementRequest {
  return {
    id: row.id,
    regionId: row.region_id,
    sku: row.sku,
    requesterId: row.requester_id,
    quantity: Number(row.quantity),
    status: row.status,
    riskScore: Number(row.risk_score),
    riskLevel: row.risk_level,
    reasons: typeof row.reasons === 'string' ? JSON.parse(row.reasons) : row.reasons,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    decidedBy: row.decided_by,
    createdAt: new Date(row.created_at),
  };
}

// Every statement is parameterised: user input never reaches the SQL text.
export const procurementRepository = {
  /**
   * Reads the baseline and locks its row for the rest of the transaction.
   * Two requests for the same region and SKU are therefore scored one after the other,
   * so the second always sees the first in its open-order total.
   */
  async lockBaseline(db: Queryable, regionId: string, sku: string): Promise<Baseline | null> {
    const { rows } = await db.query(
      `SELECT median_units, mad_units FROM demand_baselines
        WHERE region_id = $1 AND sku = $2 FOR UPDATE`,
      [regionId, sku],
    );
    if (rows.length === 0) return null;
    return { median: Number(rows[0].median_units), mad: Number(rows[0].mad_units) };
  },

  /**
   * All three scoring inputs in one round trip and one index range scan on
   * (region_id, sku, created_at): O(log n + k) for k rows in the look-back window.
   * Three separate queries would cost three scans and three network round trips.
   */
  async getWindowAggregates(
    db: Queryable,
    args: { regionId: string; sku: string; requesterId: string; quantity: number; lookbackStart: Date; duplicateStart: Date },
  ): Promise<WindowAggregates> {
    const { rows } = await db.query(
      `SELECT
         COALESCE(SUM(quantity), 0) AS open_quantity,
         COALESCE(SUM(CASE WHEN requester_id = $3 AND quantity = $4 AND created_at >= $6 THEN 1 ELSE 0 END), 0) AS duplicate_count,
         COALESCE(SUM(CASE WHEN requester_id = $3 THEN 1 ELSE 0 END), 0) AS requester_count
       FROM procurement_requests
       WHERE region_id = $1 AND sku = $2 AND created_at >= $5 AND status <> 'REJECTED'`,
      [args.regionId, args.sku, args.requesterId, args.quantity, args.lookbackStart, args.duplicateStart],
    );
    return {
      openQuantity: Number(rows[0].open_quantity),
      duplicateCount: Number(rows[0].duplicate_count),
      requesterCount: Number(rows[0].requester_count),
    };
  },

  async findById(db: Queryable, id: string, options: { forUpdate?: boolean } = {}): Promise<ProcurementRequest | null> {
    const { rows } = await db.query(
      `SELECT ${COLUMNS} FROM procurement_requests WHERE id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows.length > 0 ? toRequest(rows[0]) : null;
  },

  async findByIdempotencyKey(db: Queryable, requesterId: string, key: string): Promise<ProcurementRequest | null> {
    const { rows } = await db.query(
      `SELECT ${COLUMNS} FROM procurement_requests WHERE requester_id = $1 AND idempotency_key = $2`,
      [requesterId, key],
    );
    return rows.length > 0 ? toRequest(rows[0]) : null;
  },

  async insertRequest(db: Queryable, request: ProcurementRequest): Promise<void> {
    await db.query(
      `INSERT INTO procurement_requests
         (id, region_id, sku, requester_id, quantity, status, risk_score, risk_level,
          reasons, idempotency_key, payload_hash, decided_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        request.id, request.regionId, request.sku, request.requesterId, request.quantity,
        request.status, request.riskScore, request.riskLevel, JSON.stringify(request.reasons),
        request.idempotencyKey, request.payloadHash, request.decidedBy, request.createdAt,
      ],
    );
  },

  async updateStatus(db: Queryable, id: string, status: RequestStatus, decidedBy: string): Promise<void> {
    await db.query(`UPDATE procurement_requests SET status = $2, decided_by = $3 WHERE id = $1`, [id, status, decidedBy]);
  },

  async insertAudit(
    db: Queryable,
    entry: { requestId: string; actor: string; action: string; detail: unknown; at: Date },
  ): Promise<void> {
    await db.query(
      `INSERT INTO audit_log (request_id, actor, action, detail, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [entry.requestId, entry.actor, entry.action, JSON.stringify(entry.detail), entry.at],
    );
  },

  async insertOutbox(db: Queryable, message: { topic: string; payload: unknown; at: Date }): Promise<void> {
    await db.query(`INSERT INTO outbox (topic, payload, created_at) VALUES ($1, $2, $3)`, [
      message.topic,
      JSON.stringify(message.payload),
      message.at,
    ]);
  },
};

export type ProcurementRepository = typeof procurementRepository;
