import { describe, expect, it } from 'vitest';
import { assessRisk, holdWithoutBaseline, type RiskInput } from '../src/domain/riskEngine';

// The audit scenario: weekend demand averages 30 units.
const base: RiskInput = {
  quantity: 30,
  baselineMedian: 30,
  baselineMad: 5,
  openQuantity: 0,
  hasRecentDuplicate: false,
  requesterRecentCount: 0,
};

describe('assessRisk', () => {
  it('approves an order in line with demand', () => {
    const result = assessRisk(base);
    expect(result).toMatchObject({ score: 0, level: 'LOW', decision: 'APPROVED', reasons: [] });
  });

  it('tags the Friday order: 90 units is three times weekend demand', () => {
    const result = assessRisk({ ...base, quantity: 90 });
    expect(result.metrics.coverageRatio).toBe(3);
    expect(result.level).toBe('MEDIUM');
    expect(result.decision).toBe('APPROVED_TAGGED');
    expect(result.reasons.map((r) => r.code)).toEqual(['QUANTITY_OUTLIER']);
  });

  it('holds the Saturday order: a repeat that takes open orders to 180 units', () => {
    const result = assessRisk({ ...base, quantity: 90, openQuantity: 90, hasRecentDuplicate: true, requesterRecentCount: 1 });
    expect(result.metrics.coverageRatio).toBe(6);
    expect(result.level).toBe('HIGH');
    expect(result.decision).toBe('ON_HOLD');
    expect(result.reasons.map((r) => r.code)).toEqual(['COVERAGE_RATIO_EXCEEDED', 'QUANTITY_OUTLIER', 'DUPLICATE_ORDER']);
    expect(result.reasons[0]!.message).toContain('180 units');
  });

  it('forces a hold when a duplicate also breaches coverage, whatever the score', () => {
    // Wide spread keeps the z-score low, so the score alone would only reach MEDIUM.
    const result = assessRisk({ ...base, quantity: 50, baselineMad: 40, openQuantity: 50, hasRecentDuplicate: true });
    expect(result.score).toBeLessThan(70);
    expect(result.level).toBe('HIGH');
  });

  it('flags high request velocity', () => {
    const result = assessRisk({ ...base, requesterRecentCount: 3 });
    expect(result.reasons.map((r) => r.code)).toEqual(['HIGH_REQUEST_VELOCITY']);
    expect(result.level).toBe('LOW');
  });

  it('never scores below 0 or above 100', () => {
    expect(assessRisk({ ...base, quantity: 1 }).score).toBe(0);
    const extreme = assessRisk({ ...base, quantity: 100_000, openQuantity: 100_000, hasRecentDuplicate: true, requesterRecentCount: 50 });
    expect(extreme.score).toBe(100);
  });

  it('respects a custom policy', () => {
    const strict = assessRisk({ ...base, quantity: 60 }, { coverageRatioFlag: 1.5, zScoreFlag: 3.5, velocityFlag: 3, mediumScore: 10, highScore: 30 });
    expect(strict.level).toBe('HIGH');
  });
});

describe('holdWithoutBaseline', () => {
  it('fails closed', () => {
    expect(holdWithoutBaseline()).toMatchObject({ level: 'HIGH', decision: 'ON_HOLD', reasons: [{ code: 'NO_DEMAND_BASELINE' }] });
  });
});
