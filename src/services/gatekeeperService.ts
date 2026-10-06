import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { isUniqueViolation, withTransaction } from '../db/transaction';
import { assessRisk, DEFAULT_POLICY, holdWithoutBaseline, type RiskPolicy } from '../domain/riskEngine';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors';
import {
  procurementRepository,
  type ProcurementRepository,
  type ProcurementRequest,
} from '../repositories/procurementRepository';

export interface Actor {
  id: string;
  role: 'regional_manager' | 'senior_manager';
}

export interface SubmitCommand {
  regionId: string;
  sku: string;
  quantity: number;
  idempotencyKey: string;
}

export interface GatekeeperOptions {
  policy?: RiskPolicy;
  lookbackDays?: number;
  duplicateWindowHours?: number;
  repository?: ProcurementRepository;
  /** Injected so tests can control time. */
  clock?: () => Date;
}

const HOUR_MS = 60 * 60 * 1000;
export const RISK_REPORT_TOPIC = 'procurement.risk-level-report';

const hashPayload = (command: SubmitCommand) =>
  createHash('sha256').update(`${command.regionId}|${command.sku}|${command.quantity}`).digest('hex');

export class GatekeeperService {
  private readonly policy: RiskPolicy;
  private readonly lookbackMs: number;
  private readonly duplicateMs: number;
  private readonly repo: ProcurementRepository;
  private readonly clock: () => Date;

  constructor(private readonly pool: Pool, options: GatekeeperOptions = {}) {
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.lookbackMs = (options.lookbackDays ?? 7) * 24 * HOUR_MS;
    this.duplicateMs = (options.duplicateWindowHours ?? 48) * HOUR_MS;
    this.repo = options.repository ?? procurementRepository;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Scores and records a request. The request row, its audit entry and any risk report
   * commit together or not at all, so a failure part-way leaves nothing behind and the
   * caller can retry safely with the same idempotency key.
   */
  async submit(command: SubmitCommand, actor: Actor): Promise<{ request: ProcurementRequest; replayed: boolean }> {
    const payloadHash = hashPayload(command);

    try {
      return await withTransaction(this.pool, async (tx) => {
        const existing = await this.repo.findByIdempotencyKey(tx, actor.id, command.idempotencyKey);
        if (existing) return { request: this.assertSamePayload(existing, payloadHash), replayed: true };

        const now = this.clock();
        const baseline = await this.repo.lockBaseline(tx, command.regionId, command.sku);

        let assessment = holdWithoutBaseline();
        if (baseline) {
          const window = await this.repo.getWindowAggregates(tx, {
            regionId: command.regionId,
            sku: command.sku,
            requesterId: actor.id,
            quantity: command.quantity,
            lookbackStart: new Date(now.getTime() - this.lookbackMs),
            duplicateStart: new Date(now.getTime() - this.duplicateMs),
          });
          assessment = assessRisk(
            {
              quantity: command.quantity,
              baselineMedian: baseline.median,
              baselineMad: baseline.mad,
              openQuantity: window.openQuantity,
              hasRecentDuplicate: window.duplicateCount > 0,
              requesterRecentCount: window.requesterCount,
            },
            this.policy,
          );
        }

        const request: ProcurementRequest = {
          id: randomUUID(),
          regionId: command.regionId,
          sku: command.sku,
          requesterId: actor.id,
          quantity: command.quantity,
          status: assessment.decision,
          riskScore: assessment.score,
          riskLevel: assessment.level,
          reasons: assessment.reasons,
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          decidedBy: null,
          createdAt: now,
        };

        await this.repo.insertRequest(tx, request);
        await this.repo.insertAudit(tx, {
          requestId: request.id,
          actor: 'gatekeeper',
          action: `DECISION_${assessment.decision}`,
          detail: { score: assessment.score, metrics: assessment.metrics, reasons: assessment.reasons },
          at: now,
        });

        if (assessment.level === 'HIGH') {
          await this.repo.insertOutbox(tx, {
            topic: RISK_REPORT_TOPIC,
            payload: {
              requestId: request.id,
              regionId: request.regionId,
              sku: request.sku,
              quantity: request.quantity,
              requesterId: request.requesterId,
              riskLevel: assessment.level,
              riskScore: assessment.score,
              metrics: assessment.metrics,
              reasons: assessment.reasons,
            },
            at: now,
          });
        }

        return { request, replayed: false };
      });
    } catch (error) {
      // Two copies of the same request raced; the loser reads the winner's committed result.
      if (isUniqueViolation(error)) {
        const winner = await this.repo.findByIdempotencyKey(this.pool, actor.id, command.idempotencyKey);
        if (winner) return { request: this.assertSamePayload(winner, payloadHash), replayed: true };
      }
      throw error;
    }
  }

  async get(id: string): Promise<ProcurementRequest> {
    const request = await this.repo.findById(this.pool, id);
    if (!request) throw new NotFoundError('Procurement request not found');
    return request;
  }

  /** A senior manager releases or rejects a held order. */
  async review(id: string, outcome: 'RELEASED' | 'REJECTED', actor: Actor): Promise<ProcurementRequest> {
    if (actor.role !== 'senior_manager') {
      throw new ForbiddenError('Only a senior manager can review a held order');
    }

    return withTransaction(this.pool, async (tx) => {
      const request = await this.repo.findById(tx, id, { forUpdate: true });
      if (!request) throw new NotFoundError('Procurement request not found');
      if (request.requesterId === actor.id) {
        throw new ForbiddenError('A requester cannot review their own order');
      }
      if (request.status !== 'ON_HOLD') {
        throw new ConflictError('NOT_ON_HOLD', `Only an order on hold can be reviewed; this one is ${request.status}`);
      }

      await this.repo.updateStatus(tx, id, outcome, actor.id);
      await this.repo.insertAudit(tx, {
        requestId: id,
        actor: actor.id,
        action: `REVIEW_${outcome}`,
        detail: { previousStatus: request.status },
        at: this.clock(),
      });
      return { ...request, status: outcome, decidedBy: actor.id };
    });
  }

  private assertSamePayload(existing: ProcurementRequest, payloadHash: string): ProcurementRequest {
    if (existing.payloadHash !== payloadHash) {
      throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request body');
    }
    return existing;
  }
}
