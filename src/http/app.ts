import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { z, ZodError } from 'zod';
import { AppError, UnauthorizedError, ValidationError } from '../errors';
import type { ProcurementRequest } from '../repositories/procurementRepository';
import type { Actor, GatekeeperService } from '../services/gatekeeperService';

export interface AppDependencies {
  service: GatekeeperService;
  jwtSecret: string;
  logger?: Pick<Console, 'error'>;
}

// Allow-list validation: unknown fields are rejected, not silently ignored.
const submitBody = z.strictObject({
  regionId: z.string().regex(/^[A-Z0-9-]{2,32}$/, 'must be 2-32 characters of A-Z, 0-9 or hyphen'),
  sku: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'must be 1-64 characters of letters, digits, dot, underscore or hyphen'),
  quantity: z.number().int().min(1).max(100_000),
});
const reviewBody = z.strictObject({ outcome: z.enum(['RELEASED', 'REJECTED']) });
const idParam = z.uuid();
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const claims = z.object({ sub: z.string().min(1), role: z.enum(['regional_manager', 'senior_manager']) });

const present = (request: ProcurementRequest) => ({
  id: request.id,
  regionId: request.regionId,
  sku: request.sku,
  quantity: request.quantity,
  requesterId: request.requesterId,
  status: request.status,
  riskLevel: request.riskLevel,
  riskScore: request.riskScore,
  reasons: request.reasons,
  decidedBy: request.decidedBy,
  createdAt: request.createdAt.toISOString(),
});

export function createApp({ service, jwtSecret, logger = console }: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  function authenticate(req: Request, res: Response, next: NextFunction) {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedError();
    try {
      // The algorithm is pinned so a token cannot downgrade itself to "none" or another scheme.
      const decoded = claims.parse(jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }));
      res.locals.actor = { id: decoded.sub, role: decoded.role } satisfies Actor;
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }
    next();
  }

  const api = express.Router();
  api.use(authenticate);

  api.post('/procurement-requests', async (req, res) => {
    const key = idempotencyKey.safeParse(req.get('idempotency-key'));
    if (!key.success) {
      throw new ValidationError('An Idempotency-Key header of 8-128 URL-safe characters is required');
    }
    const body = submitBody.parse(req.body);
    const { request, replayed } = await service.submit({ ...body, idempotencyKey: key.data }, res.locals.actor);
    res.status(replayed ? 200 : 201).set('Idempotent-Replayed', String(replayed)).json(present(request));
  });

  api.get('/procurement-requests/:id', async (req, res) => {
    res.json(present(await service.get(idParam.parse(req.params.id))));
  });

  api.post('/procurement-requests/:id/review', async (req, res) => {
    const id = idParam.parse(req.params.id);
    const { outcome } = reviewBody.parse(req.body);
    res.json(present(await service.review(id, outcome, res.locals.actor)));
  });

  app.use('/api/v1', api);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // Central error handler. Expected errors keep their status; anything else is logged
  // server-side and returned as a generic 500 so internals never reach the caller.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details } });
      return;
    }
    if (error instanceof AppError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    const bodyError = error as { type?: string; status?: number };
    if (bodyError?.type === 'entity.parse.failed' || bodyError?.type === 'entity.too.large') {
      res.status(bodyError.status ?? 400).json({ error: { code: 'INVALID_BODY', message: 'Request body could not be read' } });
      return;
    }
    logger.error('Unhandled error', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  });

  return app;
}
