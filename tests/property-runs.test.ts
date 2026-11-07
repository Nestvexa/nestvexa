import { describe, expect, it } from 'vitest';
import { propertyRunMultiplier } from './support/property-runs.js';

describe('property run multiplier (NV_PROPERTY_RUNS_MULTIPLIER)', () => {
  it('defaults to the documented baseline', () => {
    expect(propertyRunMultiplier(undefined)).toBe(1);
    expect(propertyRunMultiplier('')).toBe(1);
  });

  it('accepts integers from 1 through 100', () => {
    expect(propertyRunMultiplier('1')).toBe(1);
    expect(propertyRunMultiplier('10')).toBe(10);
    expect(propertyRunMultiplier('100')).toBe(100);
  });

  it.each(['0', '101', '-1', '2.5', 'ten', '1e3', 'Infinity', 'NaN'])(
    'rejects %j instead of silently running the baseline',
    (value) => {
      expect(() => propertyRunMultiplier(value)).toThrow(
        'NV_PROPERTY_RUNS_MULTIPLIER must be an integer from 1 through 100',
      );
    },
  );
});
