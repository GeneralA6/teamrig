/** The `q` quantile of sorted values, linearly interpolated between the two nearest; null with none. */
export function quantile(sorted: readonly number[], q: number): number | null {
  const position = q * (sorted.length - 1);
  const below = sorted[Math.floor(position)];
  const above = sorted[Math.ceil(position)];
  return below === undefined || above === undefined ? null : below + (above - below) * (position - Math.floor(position));
}

/** The middle value, in any order given: the mean of the two middle ones for an even count; null with none. */
export function median(values: readonly number[]): number | null {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}
