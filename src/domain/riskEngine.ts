import { robustZScore } from './stats';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type Decision = 'APPROVED' | 'APPROVED_TAGGED' | 'ON_HOLD';

export type ReasonCode =
  | 'COVERAGE_RATIO_EXCEEDED'
  | 'QUANTITY_OUTLIER'
  | 'DUPLICATE_ORDER'
  | 'HIGH_REQUEST_VELOCITY'
  | 'NO_DEMAND_BASELINE';

export interface Reason {
  code: ReasonCode;
  message: string;
}

export interface RiskPolicy {
  /** Open-order coverage above this multiple of baseline demand is flagged. */
  coverageRatioFlag: number;
  /** Robust z-score above which a quantity counts as an outlier. */
  zScoreFlag: number;
  /** Requests from one requester for one SKU inside the window that count as high velocity. */
  velocityFlag: number;
  mediumScore: number;
  highScore: number;
}

export const DEFAULT_POLICY: RiskPolicy = {
  coverageRatioFlag: 3,
  zScoreFlag: 3.5,
  velocityFlag: 3,
  mediumScore: 40,
  highScore: 70,
};

export interface RiskInput {
  quantity: number;
  baselineMedian: number;
  baselineMad: number;
  /** Units already on open orders for this region and SKU inside the look-back window. */
  openQuantity: number;
  /** An earlier order with the same requester, SKU and quantity exists inside the duplicate window. */
  hasRecentDuplicate: boolean;
  /** Earlier requests by this requester for this SKU inside the look-back window. */
  requesterRecentCount: number;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  decision: Decision;
  reasons: Reason[];
  metrics: { coverageRatio: number; zScore: number };
}

const round = (value: number, places = 2) => Number(value.toFixed(places));

function levelFor(score: number, policy: RiskPolicy): RiskLevel {
  if (score >= policy.highScore) return 'HIGH';
  if (score >= policy.mediumScore) return 'MEDIUM';
  return 'LOW';
}

const DECISION_BY_LEVEL: Record<RiskLevel, Decision> = {
  LOW: 'APPROVED',
  MEDIUM: 'APPROVED_TAGGED',
  HIGH: 'ON_HOLD',
};

/**
 * Scores one request. Pure and O(1): every input is a pre-aggregated number,
 * so scoring cost does not grow with the size of the order history.
 */
export function assessRisk(input: RiskInput, policy: RiskPolicy = DEFAULT_POLICY): RiskAssessment {
  const reasons: Reason[] = [];
  const totalOpen = input.openQuantity + input.quantity;
  const coverageRatio = totalOpen / input.baselineMedian;
  const zScore = robustZScore(input.quantity, input.baselineMedian, input.baselineMad);

  // Coverage: 10 points for each multiple of baseline demand beyond the first, capped at 40.
  let score = Math.min(40, Math.max(0, (coverageRatio - 1) * 10));
  const coverageExceeded = coverageRatio > policy.coverageRatioFlag;
  if (coverageExceeded) {
    reasons.push({
      code: 'COVERAGE_RATIO_EXCEEDED',
      message: `${totalOpen} units on open order is ${round(coverageRatio, 1)} times the baseline demand of ${input.baselineMedian}.`,
    });
  }

  if (zScore > policy.zScoreFlag) {
    score += 25;
    reasons.push({
      code: 'QUANTITY_OUTLIER',
      message: `Quantity ${input.quantity} is a statistical outlier against the baseline (robust z-score ${round(zScore, 1)}).`,
    });
  }

  if (input.hasRecentDuplicate) {
    score += 30;
    reasons.push({
      code: 'DUPLICATE_ORDER',
      message: 'The same requester ordered the same quantity of this SKU inside the duplicate window.',
    });
  }

  if (input.requesterRecentCount >= policy.velocityFlag) {
    score += 10;
    reasons.push({
      code: 'HIGH_REQUEST_VELOCITY',
      message: `The requester has made ${input.requesterRecentCount} earlier requests for this SKU inside the look-back window.`,
    });
  }

  score = Math.round(Math.min(100, score));

  // Rule override: a repeat order that also breaches coverage is held whatever the score.
  const level = input.hasRecentDuplicate && coverageExceeded ? 'HIGH' : levelFor(score, policy);

  return {
    score,
    level,
    decision: DECISION_BY_LEVEL[level],
    reasons,
    metrics: { coverageRatio: round(coverageRatio), zScore: round(zScore) },
  };
}

/** Fail closed: with no baseline there is nothing to score against, so the order is held. */
export function holdWithoutBaseline(): RiskAssessment {
  return {
    score: 100,
    level: 'HIGH',
    decision: 'ON_HOLD',
    reasons: [
      {
        code: 'NO_DEMAND_BASELINE',
        message: 'No demand baseline exists for this region and SKU, so the request cannot be scored.',
      },
    ],
    metrics: { coverageRatio: 0, zScore: 0 },
  };
}
