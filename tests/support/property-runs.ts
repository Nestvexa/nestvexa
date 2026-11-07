/**
 * Run budget for fast-check suites. `NV_PROPERTY_RUNS_MULTIPLIER` (an integer
 * from 1 through 100, default 1) scales every suite's documented baseline so
 * the nightly workflow can run the same properties longer without editing
 * them. Invalid values fail loudly instead of silently running the baseline.
 */
export function propertyRunMultiplier(
  value: string | undefined = process.env['NV_PROPERTY_RUNS_MULTIPLIER'],
): number {
  if (value === undefined || value === '') return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100)
    throw new Error(
      'NV_PROPERTY_RUNS_MULTIPLIER must be an integer from 1 through 100',
    );
  return parsed;
}

/** fast-check parameters for a suite baseline of `numRuns` runs. */
export function propertyRuns(numRuns: number): { numRuns: number } {
  return { numRuns: numRuns * propertyRunMultiplier() };
}
