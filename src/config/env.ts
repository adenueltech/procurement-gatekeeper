import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  // No default: the service refuses to start without a real secret.
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  COVERAGE_RATIO_FLAG: z.coerce.number().positive().default(3),
  DUPLICATE_WINDOW_HOURS: z.coerce.number().positive().default(48),
  LOOKBACK_DAYS: z.coerce.number().positive().default(7),
});

export type Env = z.infer<typeof schema>;

/**
 * Validates configuration once at start-up and fails fast.
 * The error names the variables at fault but never echoes their values.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return result.data;
}
