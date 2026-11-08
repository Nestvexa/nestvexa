import { describe, expect, it } from 'vitest';

// SEC-016: the license audit and secret scan used by `pnpm audit:licenses`,
// `pnpm secrets:scan` and the Dependency security workflow.

interface LicenseModule {
  classify(expression: unknown): 'allowed' | 'copyleft' | 'unknown';
}
interface SecretsModule {
  scanText(text: string): { rule: string; line: number }[];
}

const licenses = (await import(
  new URL('../scripts/licenses.mjs', import.meta.url).href
)) as LicenseModule;
const secrets = (await import(
  new URL('../scripts/secrets.mjs', import.meta.url).href
)) as SecretsModule;

describe('license classification', () => {
  it.each([
    ['MIT', 'allowed'],
    ['Apache-2.0', 'allowed'],
    ['(MIT OR Apache-2.0)', 'allowed'],
    ['MIT AND ISC', 'allowed'],
    ['GPL-3.0-only OR MIT', 'allowed'],
    ['Apache-2.0 WITH LLVM-exception', 'allowed'],
    ['GPL-3.0-only', 'copyleft'],
    ['AGPL-3.0-or-later', 'copyleft'],
    ['LGPL-2.1-only', 'copyleft'],
    ['MPL-2.0', 'copyleft'],
    ['MIT AND GPL-2.0-only', 'copyleft'],
    ['SSPL-1.0', 'copyleft'],
    ['CC-BY-SA-4.0', 'copyleft'],
    ['UNLICENSED', 'unknown'],
    ['SEE LICENSE IN LICENSE.md', 'unknown'],
    ['Custom', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ])('classifies %j as %s', (expression, verdict) => {
    expect(licenses.classify(expression)).toBe(verdict);
  });
});

describe('secret scan rules', () => {
  // Built at runtime so this file never contains a credential-shaped literal.
  const repeat = (text: string, count: number) => text.repeat(count);
  const samples: readonly (readonly [string, string])[] = [
    ['private-key', `-----BEGIN ${'RSA '}PRIVATE KEY-----`],
    ['private-key', `-----BEGIN ${'OPENSSH '}PRIVATE KEY-----`],
    ['aws-access-key-id', `key = "${'AKIA'}${repeat('Q', 16)}"`],
    ['aws-secret-access-key', `aws_secret_access_key = ${repeat('aB3/', 10)}`],
    ['github-token', `token: ${'ghp'}_${repeat('a1', 18)}`],
    [
      'npm-token',
      `//registry.npmjs.org/:_authToken=${'npm'}_${repeat('Z', 36)}`,
    ],
    ['slack-token', `${'xox'}b-${repeat('1', 12)}-abcdef`],
    ['stripe-live-key', `${'sk'}_live_${repeat('x', 24)}`],
    ['google-api-key', `${'AIza'}${repeat('S', 35)}`],
    [
      'url-credentials',
      `postgres://app:${repeat('p', 16)}@db.internal:5432/app`,
    ],
  ];
  it.each(samples)('detects %s', (rule, line) => {
    expect(secrets.scanText(`first line\n${line}\n`)).toEqual([
      { rule, line: 2 },
    ]);
  });

  it('ignores documentation placeholders, short fixture passwords and allowed lines', () => {
    const text = [
      'accessKeyId: "AKIAIOSFODNN7EXAMPLE",',
      'redis://user:short@redis:6379', // trufflehog:ignore (placeholder fixture)
      'http://user:$PASSWORD_FROM_ENV@host/', // trufflehog:ignore (placeholder fixture)
      `${'AKIA'}${repeat('Q', 16)} // nestvexa-secret-scan: allow fixture`,
      '// nestvexa-secret-scan: allow-next-line',
      `${'AKIA'}${repeat('Q', 16)}`,
      `${'AKIA'}${repeat('Q', 16)}`,
    ].join('\n');
    expect(secrets.scanText(text)).toEqual([
      { rule: 'aws-access-key-id', line: 7 },
    ]);
  });
});
