import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/** WCAG 2.0, 2.1 and 2.2 level A and AA rule tags (the QA-075 target). */
export const WCAG_AA_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
] as const;

/**
 * The default scan of every browser spec: axe's default rule set (WCAG 2.0
 * and 2.1 A/AA plus best practices) with the WCAG 2.2 AA rules axe leaves
 * disabled by default switched on (`target-size`, success criterion 2.5.8).
 */
export function axe(page: Page): AxeBuilder {
  return new AxeBuilder({ page }).options({
    rules: { 'target-size': { enabled: true } },
  });
}

/** WCAG 2.0-2.2 A/AA rules only, without best practices. */
export function wcagAxe(page: Page): AxeBuilder {
  return new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]);
}
