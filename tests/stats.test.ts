import { describe, expect, it } from 'vitest';
import { median, medianAbsoluteDeviation, robustZScore } from '../src/domain/stats';

describe('median', () => {
  it('returns the middle value of an odd-length list', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('averages the two middle values of an even-length list', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('handles duplicates and a single element', () => {
    expect(median([7, 7, 7, 7])).toBe(7);
    expect(median([42])).toBe(42);
  });

  it('does not mutate its input', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it('matches a sort-based median on random data', () => {
    for (let run = 0; run < 200; run++) {
      const values = Array.from({ length: 1 + Math.floor(Math.random() * 60) }, () => Math.floor(Math.random() * 100));
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const expected = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      expect(median(values)).toBe(expected);
    }
  });

  it('rejects an empty list', () => {
    expect(() => median([])).toThrow(RangeError);
  });
});

describe('medianAbsoluteDeviation', () => {
  it('ignores a single extreme outlier', () => {
    // Median 30; deviations 5, 2, 0, 2, 870 -> MAD 2.
    expect(medianAbsoluteDeviation([25, 28, 30, 32, 900])).toBe(2);
  });
});

describe('robustZScore', () => {
  it('scales by 1.4826 x MAD', () => {
    expect(robustZScore(90, 30, 5)).toBeCloseTo(60 / (1.4826 * 5), 6);
  });

  it('stays finite when MAD is zero', () => {
    expect(robustZScore(33, 30, 0)).toBe(1);
    expect(robustZScore(2, 0, 0)).toBe(2);
  });
});
