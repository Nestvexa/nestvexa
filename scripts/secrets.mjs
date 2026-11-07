// Secret scan of the repository working tree: every tracked file plus
// untracked files that are not ignored (so a secret is caught before its
// first commit). Dependency-free and offline; CI additionally runs the pinned
// TruffleHog action over the git history (supply-chain job in
// .github/workflows/ci.yml).
//
// Rules are high-confidence credential formats only, so a finding is worth
// stopping for. A line that intentionally contains a credential-shaped test
// value must carry the marker `nestvexa-secret-scan: allow` with a reason.
//
//   pnpm secrets:scan [--json artifacts/reports/secrets.json]
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @type {readonly { id: string; description: string; pattern: RegExp }[]} */
export const rules = [
  {
    id: 'private-key',
    description: 'PEM/OpenSSH/PGP private key block',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key assignment',
    pattern:
      /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/i,
  },
  {
    id: 'github-token',
    description: 'GitHub personal access, OAuth, app or refresh token',
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82})\b/,
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
  },
  {
    id: 'slack-token',
    description: 'Slack token or incoming webhook',
    pattern:
      /\bxox[abposr]-[0-9A-Za-z-]{10,}|hooks\.slack\.com\/services\/T[0-9A-Z]{8,}\/B[0-9A-Z]{8,}\/[0-9A-Za-z]{24}/,
  },
  {
    id: 'stripe-live-key',
    description: 'Stripe live secret or restricted key',
    pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key',
    pattern: /\bsk-ant-(?:api|admin)\d{2}-[0-9A-Za-z_-]{80,}/,
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API key',
    pattern:
      /\bsk-(?:proj-|svcacct-|admin-)?[0-9A-Za-z_-]{20}T3BlbkFJ[0-9A-Za-z_-]{20,}/,
  },
  {
    id: 'url-credentials',
    description: 'URL with an embedded password of 12+ characters',
    pattern:
      /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?|smtps?):\/\/[^\s/:@'"`]+:[^\s/@'"`$]{12,}@[^\s/'"`]+/,
  },
];

const allowMarker = 'nestvexa-secret-scan: allow';

/**
 * Published documentation placeholders that are not credentials (AWS SigV4
 * test vectors from the AWS documentation).
 */
const placeholders = [
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
];

/** Files that must never be committed whatever their content. */
function forbiddenName(path) {
  const name = basename(path);
  return (
    /^\.env(?:\..+)?$/.test(name) &&
    !/^\.env\.(?:example|sample|template|defaults)$/.test(name)
  );
}

/** Findings for one file's text: `{ rule, line }` with no secret value. */
export function scanText(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    // The marker allows its own line, or the next one when it is
    // `allow-next-line` (so formatters can keep the comment above).
    if (raw.includes(allowMarker) && !raw.includes(`${allowMarker}-next-line`))
      return;
    if (lines[index - 1]?.includes(`${allowMarker}-next-line`)) return;
    let line = raw;
    for (const placeholder of placeholders)
      line = line.split(placeholder).join('');
    for (const rule of rules)
      if (rule.pattern.test(line))
        findings.push({ rule: rule.id, line: index + 1 });
  });
  return findings;
}

function files(root) {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(`git ls-files failed: ${result.stderr.toString('utf8')}`);
  return [
    ...new Set(result.stdout.toString('utf8').split('\0').filter(Boolean)),
  ];
}

export function scan(root) {
  const findings = [];
  let scanned = 0;
  for (const path of files(root)) {
    if (forbiddenName(path)) {
      findings.push({ path, rule: 'env-file', line: 0 });
      continue;
    }
    const absolute = join(root, path);
    let size;
    try {
      size = statSync(absolute).size;
    } catch {
      continue; // deleted in the working tree
    }
    if (size > 5 * 1024 * 1024) continue;
    const buffer = readFileSync(absolute);
    if (buffer.includes(0)) continue; // binary
    scanned++;
    for (const finding of scanText(buffer.toString('utf8')))
      findings.push({ path, ...finding });
  }
  return { scanned, findings };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  const index = process.argv.indexOf('--json');
  const report = resolve(
    root,
    index > 0
      ? (process.argv[index + 1] ?? '')
      : 'artifacts/reports/secrets.json',
  );
  const { scanned, findings } = scan(root);
  await mkdir(dirname(report), { recursive: true });
  await writeFile(
    report,
    JSON.stringify(
      {
        schema: 'nestvexa-secret-scan/1',
        generatedAt: new Date().toISOString(),
        rules: rules.map(({ id, description }) => ({ id, description })),
        scanned,
        findings,
      },
      null,
      2,
    ) + '\n',
  );
  if (findings.length) {
    for (const finding of findings)
      console.error(`  ${finding.rule}: ${finding.path}:${finding.line}`);
    console.error(
      `Secret scan failed: ${findings.length} finding(s) in ${scanned} files. Remove and rotate the credential; for a deliberate test value add "${allowMarker}" with a reason.`,
    );
    process.exit(1);
  }
  console.log(
    `Secret scan: ${scanned} files, ${rules.length} rules, no findings. Report: ${report}`,
  );
}
