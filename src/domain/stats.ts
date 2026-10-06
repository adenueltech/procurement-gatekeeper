/**
 * k-th smallest value (0-indexed) by quickselect.
 * Average O(n) time and O(1) extra space, against O(n log n) for a full sort.
 * A random pivot keeps the O(n^2) worst case from being triggered by sorted input.
 * Mutates `values`.
 */
function quickselect(values: number[], k: number): number {
  let lo = 0;
  let hi = values.length - 1;

  while (lo < hi) {
    const pivot = values[lo + Math.floor(Math.random() * (hi - lo + 1))]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (values[i]! < pivot) i++;
      while (values[j]! > pivot) j--;
      if (i <= j) {
        [values[i], values[j]] = [values[j]!, values[i]!];
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return values[k]!;
}

/** Median in average O(n). Does not mutate the input. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of an empty list is undefined');
  const copy = [...values];
  const mid = Math.floor(copy.length / 2);
  const upper = quickselect(copy, mid);
  if (copy.length % 2 === 1) return upper;
  // After the partition every element left of `mid` is <= upper, so the lower middle is their max.
  let lower = -Infinity;
  for (let i = 0; i < mid; i++) lower = Math.max(lower, copy[i]!);
  return (lower + upper) / 2;
}

/** Median absolute deviation: a spread measure that past outliers cannot inflate. */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  const centre = median(values);
  return median(values.map((value) => Math.abs(value - centre)));
}

// Scales MAD to be comparable with a standard deviation for normally distributed data.
const MAD_SCALE = 1.4826;

/**
 * Robust z-score: (x - median) / (1.4826 * MAD).
 * When MAD is zero (identical history) a floor of 10% of the median, at least 1 unit,
 * is used so the score stays finite.
 */
export function robustZScore(value: number, centre: number, mad: number): number {
  const spread = mad > 0 ? MAD_SCALE * mad : Math.max(1, 0.1 * Math.abs(centre));
  return (value - centre) / spread;
}
