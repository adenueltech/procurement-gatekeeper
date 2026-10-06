import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/http/app';
import { procurementRepository } from '../src/repositories/procurementRepository';
import { GatekeeperService, RISK_REPORT_TOPIC } from '../src/services/gatekeeperService';
import { createTestDb } from './helpers/testDb';

const SECRET = 'test-only-secret-that-is-long-enough-000000';
const URL = '/api/v1/procurement-requests';
const FRIDAY = new Date('2026-10-02T10:00:00Z');
const SATURDAY = new Date('2026-10-03T09:00:00Z');

const token = (sub: string, role = 'regional_manager', secret = SECRET, options: jwt.SignOptions = {}) =>
  jwt.sign({ sub, role }, secret, { algorithm: 'HS256', expiresIn: '5m', ...options });

async function setup(repository = procurementRepository) {
  const db = await createTestDb();
  const clock = { now: FRIDAY };
  const logger = { error: vi.fn() };
  const service = new GatekeeperService(db.pool, { repository, clock: () => clock.now });
  const app = createApp({ service, jwtSecret: SECRET, logger });

  const submit = (body: unknown, key: string, user = 'manager-lagos') =>
    request(app).post(URL).set('Authorization', `Bearer ${token(user)}`).set('Idempotency-Key', key).send(body as object);

  return { app, db, clock, logger, submit };
}

const order = { regionId: 'NG-LAGOS', sku: 'SKU-1001', quantity: 90 };

describe('POST /procurement-requests', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
    await ctx.db.seedBaseline('NG-LAGOS', 'SKU-1001', 30, 5);
  });

  it('tags the Friday order, then holds the repeat order on Saturday and queues a risk report', async () => {
    const friday = await ctx.submit(order, 'friday-order-0001');
    expect(friday.status).toBe(201);
    expect(friday.body).toMatchObject({ status: 'APPROVED_TAGGED', riskLevel: 'MEDIUM' });
    expect(await ctx.db.count('outbox')).toBe(0);

    ctx.clock.now = SATURDAY;
    const saturday = await ctx.submit(order, 'saturday-order-0001');
    expect(saturday.status).toBe(201);
    expect(saturday.body).toMatchObject({ status: 'ON_HOLD', riskLevel: 'HIGH' });
    expect(saturday.body.reasons.map((r: { code: string }) => r.code)).toEqual([
      'COVERAGE_RATIO_EXCEEDED',
      'QUANTITY_OUTLIER',
      'DUPLICATE_ORDER',
    ]);

    const { rows } = await ctx.db.pool.query('SELECT topic, payload FROM outbox');
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe(RISK_REPORT_TOPIC);
    expect(rows[0].payload).toMatchObject({ requestId: saturday.body.id, riskLevel: 'HIGH', metrics: { coverageRatio: 6 } });
    expect(await ctx.db.count('audit_log')).toBe(2);
  });

  it('does not treat an order outside the 48-hour window as a duplicate', async () => {
    await ctx.submit(order, 'first-order-0001');
    ctx.clock.now = new Date(FRIDAY.getTime() + 72 * 60 * 60 * 1000);
    const later = await ctx.submit(order, 'later-order-0001');
    expect(later.body.reasons.map((r: { code: string }) => r.code)).not.toContain('DUPLICATE_ORDER');
  });

  it('holds a request for a SKU with no demand baseline', async () => {
    const res = await ctx.submit({ ...order, sku: 'SKU-UNKNOWN' }, 'no-baseline-0001');
    expect(res.body).toMatchObject({ status: 'ON_HOLD', reasons: [{ code: 'NO_DEMAND_BASELINE' }] });
  });

  it('replays the stored result for a repeated idempotency key without scoring twice', async () => {
    const first = await ctx.submit(order, 'retry-key-0001');
    const retry = await ctx.submit(order, 'retry-key-0001');
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    expect(await ctx.db.count('procurement_requests')).toBe(1);
  });

  it('rejects an idempotency key reused with a different body', async () => {
    await ctx.submit(order, 'reused-key-0001');
    const res = await ctx.submit({ ...order, quantity: 5 }, 'reused-key-0001');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it.each([
    ['a negative quantity', { ...order, quantity: -5 }, 'quantity'],
    ['a fractional quantity', { ...order, quantity: 1.5 }, 'quantity'],
    ['a string quantity', { ...order, quantity: '90' }, 'quantity'],
    ['an oversized quantity', { ...order, quantity: 1_000_000 }, 'quantity'],
    ['an injection attempt in the SKU', { ...order, sku: "x'; DROP TABLE outbox;--" }, 'sku'],
    ['a missing region', { sku: order.sku, quantity: 1 }, 'regionId'],
  ])('rejects %s', async (_label, body, field) => {
    const res = await ctx.submit(body, 'invalid-body-0001');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe(field);
    expect(await ctx.db.count('procurement_requests')).toBe(0);
  });

  it('rejects unknown fields instead of ignoring them', async () => {
    const res = await ctx.submit({ ...order, status: 'APPROVED' }, 'extra-field-0001');
    expect(res.status).toBe(400);
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await request(ctx.app).post(URL).set('Authorization', `Bearer ${token('manager-lagos')}`).send(order);
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const res = await request(ctx.app)
      .post(URL)
      .set('Authorization', `Bearer ${token('manager-lagos')}`)
      .set('Content-Type', 'application/json')
      .send('{"regionId": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });
});

describe('authentication', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    ctx = await setup();
  });

  it.each([
    ['no token', undefined],
    ['a token signed with another secret', `Bearer ${token('mallory', 'senior_manager', 'another-secret-another-secret-another')}`],
    ['an expired token', `Bearer ${token('manager-lagos', 'regional_manager', SECRET, { expiresIn: -10 })}`],
    ['an unsigned token', `Bearer ${jwt.sign({ sub: 'mallory', role: 'senior_manager' }, '', { algorithm: 'none' })}`],
    ['an unknown role', `Bearer ${token('manager-lagos', 'superuser')}`],
    ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
  ])('rejects %s', async (_label, header) => {
    const req = request(ctx.app).get(`${URL}/5b1c7f0e-8f5e-4a53-9a59-0d6d2c1f3a77`);
    const res = await (header ? req.set('Authorization', header) : req);
    expect(res.status).toBe(401);
  });

  it('serves the health check without a token', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('reviewing a held order', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let heldId: string;

  beforeEach(async () => {
    ctx = await setup();
    heldId = (await ctx.submit({ ...order, sku: 'SKU-UNKNOWN' }, 'held-order-0001')).body.id;
  });

  const review = (id: string, user: string, role: string, outcome = 'RELEASED') =>
    request(ctx.app).post(`${URL}/${id}/review`).set('Authorization', `Bearer ${token(user, role)}`).send({ outcome });

  it('lets a senior manager release it and records the decision', async () => {
    const res = await review(heldId, 'director-1', 'senior_manager');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'RELEASED', decidedBy: 'director-1' });

    const fetched = await request(ctx.app).get(`${URL}/${heldId}`).set('Authorization', `Bearer ${token('director-1', 'senior_manager')}`);
    expect(fetched.body.status).toBe('RELEASED');
    expect(await ctx.db.count('audit_log')).toBe(2);
  });

  it('refuses a regional manager', async () => {
    expect((await review(heldId, 'manager-abuja', 'regional_manager')).status).toBe(403);
  });

  it('refuses a senior manager reviewing their own order', async () => {
    expect((await review(heldId, 'manager-lagos', 'senior_manager')).status).toBe(403);
  });

  it('refuses a second review of the same order', async () => {
    await review(heldId, 'director-1', 'senior_manager', 'REJECTED');
    const again = await review(heldId, 'director-1', 'senior_manager');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOT_ON_HOLD');
  });

  it('returns 404 for an unknown order and 400 for a malformed id', async () => {
    expect((await review('5b1c7f0e-8f5e-4a53-9a59-0d6d2c1f3a77', 'director-1', 'senior_manager')).status).toBe(404);
    expect((await review('not-a-uuid', 'director-1', 'senior_manager')).status).toBe(400);
  });
});

describe('failure part-way through a transaction', () => {
  it('rolls everything back, hides the cause, and lets the same key succeed on retry', async () => {
    let failNextOutboxWrite = true;
    const flakyRepository = {
      ...procurementRepository,
      async insertOutbox(...args: Parameters<typeof procurementRepository.insertOutbox>) {
        if (failNextOutboxWrite) {
          failNextOutboxWrite = false;
          throw new Error('connection terminated: password=s3cr3t host=10.0.0.5');
        }
        return procurementRepository.insertOutbox(...args);
      },
    };
    const ctx = await setup(flakyRepository);

    // No baseline -> HIGH risk -> the request and audit rows are written, then the outbox write fails.
    const failed = await ctx.submit(order, 'flaky-key-0001');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
    expect(JSON.stringify(failed.body)).not.toContain('s3cr3t');
    expect(ctx.logger.error).toHaveBeenCalledOnce();

    expect(await ctx.db.count('procurement_requests')).toBe(0);
    expect(await ctx.db.count('audit_log')).toBe(0);
    expect(await ctx.db.count('outbox')).toBe(0);

    const retry = await ctx.submit(order, 'flaky-key-0001');
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('false');
    expect(await ctx.db.count('procurement_requests')).toBe(1);
    expect(await ctx.db.count('outbox')).toBe(1);
  });
});
