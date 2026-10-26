import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = 'NESTVEXA_MASTER_IMPLEMENTATION_PROMPT.md';
const ledgerPath = 'docs/implementation/feature-ledger.json';
const markdownPath = 'docs/implementation/feature-ledger.md';
const groups = {
  0: 'MISSION',
  1: 'VISION',
  2: 'UPSTREAM',
  3: 'ARCH',
  4: 'CORE',
  5: 'CORE',
  6: 'VIEW',
  7: 'PROT',
  8: 'BROW',
  9: 'FORM',
  10: 'UP',
  11: 'INERT',
  12: 'ISLAND',
  13: 'ACT',
  14: 'REAL',
  15: 'DATA',
  16: 'EXT',
  17: 'SEC',
  18: 'QA',
  19: 'DX',
  20: 'QA',
  21: 'QA',
  22: 'DOC',
  23: 'PHASE',
  24: 'LEDGER',
  25: 'REL',
  26: 'QA',
  27: 'SHOWCASE',
  28: 'REVIEW',
  29: 'MAINT',
  30: 'REPORT',
  31: 'EXEC',
};
const packages = {
  CORE: '@nestvexa/core',
  VIEW: '@nestvexa/views',
  LIVE: '@nestvexa/live',
  PROT: '@nestvexa/live',
  BROW: '@nestvexa/client',
  DIR: '@nestvexa/client',
  FORM: '@nestvexa/forms',
  UP: '@nestvexa/uploads',
  INERT: '@nestvexa/inertia',
  SPA: '@nestvexa/react; @nestvexa/vue; @nestvexa/svelte',
  ISLAND: '@nestvexa/islands',
  ACT: '@nestvexa/actions',
  REAL: '@nestvexa/realtime',
  DATA: 'stores/cache/jobs',
  EXT: 'optional extensions',
  DX: '@nestvexa/cli',
  SEC: 'cross-package',
  QA: 'cross-package',
  DOC: 'documentation',
  PHASE: 'cross-package',
};
const hash = (text) => createHash('sha256').update(text).digest('hex');

export function extractRequirements(source) {
  const rows = [];
  let section = -1;
  let subsection = '';
  let fence = false;
  let block = [];
  let blockStart = 0;
  const lines = source.split(/\r?\n/);
  const add = (text, line, kind = 'requirement') => {
    if (section < 0 || section > 31 || !text.trim()) return;
    let group = groups[section];
    if (section === 7 && /^7\.[34]/.test(subsection)) group = 'LIVE';
    if (section === 8 && subsection.startsWith('8.3')) group = 'DIR';
    if (section === 11 && subsection.startsWith('11.2')) group = 'SPA';
    rows.push({
      sourceKey: hash(section + ':' + subsection + ':' + kind + ':' + text),
      section,
      subsection,
      sourceLine: line,
      kind,
      group,
      requirement: text,
    });
  };
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      if (!fence) {
        fence = true;
        block = [];
        blockStart = index + 1;
      } else {
        add(block.join('\n'), blockStart, 'contract-example');
        // CLI reference lists contain individually required commands.
        if (subsection.startsWith('19.1'))
          for (const [offset, command] of block.entries())
            if (command.startsWith('nestvexa '))
              add(command, blockStart + offset + 1, 'cli-command');
        fence = false;
      }
      continue;
    }
    if (fence) {
      block.push(raw);
      continue;
    }
    const heading = /^## (\d+)\./.exec(line);
    if (heading) {
      section = Number(heading[1]);
      subsection = heading[1];
      add(line.replace(/^#+ /, ''), index + 1, 'section');
      continue;
    }
    const child = /^### (\d+\.\d+|PHASE \d+)/.exec(line);
    if (child) {
      subsection = child[1];
      add(line.replace(/^#+ /, ''), index + 1, 'subsection');
      continue;
    }
    if (
      !line ||
      line === '---' ||
      line === '**Tasks**' ||
      /^\|\s*[-:]+/.test(line)
    )
      continue;
    add(line, index + 1, line.startsWith('|') ? 'table-row' : 'requirement');
  }
  if (fence)
    throw new Error(
      'Unclosed source fence; refusing incomplete requirement extraction',
    );
  return rows;
}

export function validateLedger(
  ledger,
  source,
  {
    release = false,
    fileExists = (path) => existsSync(path) && statSync(path).isFile(),
    readEvidence = (path) => readFileSync(path, 'utf8'),
  } = {},
) {
  const errors = [];
  const expected = extractRequirements(source);
  const expectedKeys = new Set(expected.map((item) => item.sourceKey));
  const actualKeys = new Set();
  const ids = new Set();
  const statuses = new Set(['Pending', 'InProgress', 'Blocked', 'Done']);
  if (ledger.sourceSha256 !== hash(source))
    errors.push('Source fingerprint changed; regenerate the ledger');
  if (!Array.isArray(ledger.features)) return ['features must be an array'];
  for (const item of ledger.features) {
    if (!item || typeof item !== 'object') {
      errors.push('Invalid feature object');
      continue;
    }
    const id = String(item.id);
    if (ids.has(id)) errors.push('Duplicate ID: ' + id);
    ids.add(id);
    if (actualKeys.has(item.sourceKey))
      errors.push('Duplicate source requirement: ' + id);
    actualKeys.add(item.sourceKey);
    if (!expectedKeys.has(item.sourceKey))
      errors.push('Unknown or obsolete requirement: ' + id);
    if (!statuses.has(item.state)) errors.push('Invalid state: ' + id);
    if (item.state === 'Blocked' && !item.outstandingIssues?.length)
      errors.push('Blocked item needs a reason: ' + id);
    for (const field of [
      'implementationFiles',
      'testFiles',
      'docs',
      'examples',
    ]) {
      if (!Array.isArray(item[field])) {
        errors.push(id + ' requires array ' + field);
        continue;
      }
      if (item.state === 'Done' && !item[field].length)
        errors.push(id + ' lacks ' + field);
      for (const path of item[field]) {
        if (typeof path !== 'string') {
          errors.push(id + ' has invalid path');
          continue;
        }
        const absolute = resolve(root, path);
        const local = relative(root, absolute);
        if (
          isAbsolute(path) ||
          local.startsWith('..') ||
          isAbsolute(local) ||
          !fileExists(absolute)
        )
          errors.push(id + ' has missing/unsafe evidence path: ' + path);
        else if (
          item.state === 'Done' &&
          ['implementationFiles', 'testFiles'].includes(field)
        ) {
          const contents = readEvidence(absolute);
          if (!contents.trim())
            errors.push(id + ' has empty evidence file: ' + path);
          if (
            field === 'implementationFiles' &&
            /throw\s+new\s+Error\s*\(\s*['"`]not implemented/i.test(contents)
          )
            errors.push(
              id + ' contains unimplemented runtime evidence: ' + path,
            );
          if (
            field === 'testFiles' &&
            /\b(?:it|test|describe)\.(?:skip|only)\s*\(/.test(contents)
          )
            errors.push(
              id + ' contains skipped/focused test evidence: ' + path,
            );
        }
      }
    }
    if (item.state === 'Done') {
      if (!item.securityNotes?.trim())
        errors.push(id + ' lacks security notes');
      if (!item.validationEvidence?.length)
        errors.push(id + ' lacks validation evidence');
      if (item.outstandingIssues?.length)
        errors.push(id + ' is Done with open issues');
      for (const evidence of item.validationEvidence ?? []) {
        if (
          !evidence.command ||
          evidence.exitCode !== 0 ||
          !Number.isFinite(Date.parse(evidence.executedAt)) ||
          !evidence.report
        )
          errors.push(id + ' has incomplete/failed command evidence');
        else {
          const absolute = resolve(root, evidence.report);
          const local = relative(root, absolute);
          if (
            isAbsolute(evidence.report) ||
            local.startsWith('..') ||
            !fileExists(absolute)
          )
            errors.push(id + ' missing command report');
        }
      }
    }
    if (release && item.state !== 'Done') errors.push(id + ' is ' + item.state);
  }
  for (const item of expected)
    if (!actualKeys.has(item.sourceKey))
      errors.push('Missing source requirement at line ' + item.sourceLine);
  return errors;
}

function generate(source) {
  const previous = existsSync(resolve(root, ledgerPath))
    ? JSON.parse(readFileSync(resolve(root, ledgerPath), 'utf8'))
    : { features: [] };
  const old = new Map(previous.features.map((item) => [item.sourceKey, item]));
  const counters = {};
  for (const item of previous.features) {
    const match = /^([A-Z]+)-(\d+)$/.exec(item.id);
    if (match)
      counters[match[1]] = Math.max(counters[match[1]] ?? 0, Number(match[2]));
  }
  const features = extractRequirements(source).map((item) => {
    const existing = old.get(item.sourceKey);
    if (existing) return { ...existing, ...item };
    counters[item.group] = (counters[item.group] ?? 0) + 1;
    return {
      ...item,
      id: item.group + '-' + String(counters[item.group]).padStart(3, '0'),
      priority: ['SEC', 'PROT', 'ACT'].includes(item.group) ? 'P0' : 'P1',
      package:
        packages[item.group] ?? 'cross-package governance and acceptance',
      implementationFiles: [],
      testFiles: [],
      docs: [],
      examples: [],
      securityNotes: '',
      state: 'Pending',
      validationEvidence: [],
      outstandingIssues: [],
    };
  });
  const removed = previous.features.filter(
    (item) => !features.some((next) => next.sourceKey === item.sourceKey),
  );
  if (removed.length)
    throw new Error(
      'Source removed/changed tracked requirements; review manually before regeneration: ' +
        removed.map((item) => item.id).join(', '),
    );
  const ledger = {
    schemaVersion: 1,
    source: sourcePath,
    sourceSha256: hash(source),
    extractedScope:
      'Every content unit in numbered sections 0–31, including phases 0–17 and the final Definition of Done. Compound source bullets remain compound acceptance requirements.',
    features,
  };
  mkdirSync(resolve(root, dirname(ledgerPath)), { recursive: true });
  writeFileSync(
    resolve(root, ledgerPath),
    JSON.stringify(ledger, null, 2) + '\n',
  );
  const escape = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('|', '\\|')
      .replaceAll('\n', '<br>');
  const paths = (values) =>
    values.map((value) => '[' + value + '](../../' + value + ')').join('\n');
  const header =
    '# Nestvexa feature ledger\n\nGenerated by `node scripts/ledger.mjs generate` from the untouched master prompt. Edit evidence/status in `feature-ledger.json`, then regenerate. Source headings and examples are retained as acceptance units; each compound requirement must be fully verified before Done. Pending is not a passed gate.\n\n`check` verifies coverage and evidence integrity. `release` additionally fails for every unfinished requirement. File presence and recorded successful commands are necessary, not proof of a security review or correctness.\n\n| ID | Requirement | Priority | Package | Implementation | Tests | Docs | Example | Security notes | State | Validation evidence | Outstanding issues |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
  const body = features
    .map(
      (item) =>
        '| ' +
        [
          item.id,
          item.requirement + ' (source L' + item.sourceLine + ')',
          item.priority,
          item.package,
          paths(item.implementationFiles),
          paths(item.testFiles),
          paths(item.docs),
          paths(item.examples),
          item.securityNotes,
          item.state,
          item.validationEvidence
            .map((entry) => entry.command + ': ' + entry.report)
            .join('; '),
          item.outstandingIssues.join('; '),
        ]
          .map(escape)
          .join(' | ') +
        ' |',
    )
    .join('\n');
  writeFileSync(resolve(root, markdownPath), header + body + '\n');
  return ledger;
}

function selfTest() {
  const source =
    '## 4. API\n### 4.1 Setup\n- Implement config\n\n## 23. Phases\n### PHASE 0 — Audit\n0.1 Inspect\n';
  const features = extractRequirements(source).map((item, index) => ({
    ...item,
    id: 'TEST-' + index,
    state: 'Pending',
    implementationFiles: [],
    testFiles: [],
    docs: [],
    examples: [],
    outstandingIssues: [],
  }));
  const ledger = { sourceSha256: hash(source), features };
  assert.deepEqual(validateLedger(ledger, source), []);
  assert.ok(
    validateLedger(ledger, source, { release: true }).length ===
      features.length,
  );
  const invalid = structuredClone(ledger);
  invalid.features[0].state = 'Done';
  assert.ok(
    validateLedger(invalid, source).some((message) =>
      message.includes('lacks implementationFiles'),
    ),
  );
  invalid.features.pop();
  assert.ok(
    validateLedger(invalid, source).some((message) =>
      message.includes('Missing source'),
    ),
  );
  invalid.features[0].implementationFiles = ['../../private'];
  assert.ok(
    validateLedger(invalid, source).some((message) =>
      message.includes('unsafe evidence'),
    ),
  );
  invalid.features[0].validationEvidence = [
    {
      command: 'test',
      exitCode: 1,
      executedAt: '2026-10-24',
      report: 'test.json',
    },
  ];
  assert.ok(
    validateLedger(invalid, source).some((message) =>
      message.includes('failed command'),
    ),
  );
  assert.ok(
    validateLedger(ledger, source + '\n- More').some((message) =>
      message.includes('fingerprint'),
    ),
  );
  invalid.features[0].implementationFiles = ['packages/example/src/index.ts'];
  invalid.features[0].testFiles = ['tests/example.test.ts'];
  assert.ok(
    validateLedger(invalid, source, {
      fileExists: () => true,
      readEvidence: () => 'throw new Error("Not implemented")',
    }).some((message) => message.includes('unimplemented runtime')),
  );
  assert.ok(
    validateLedger(invalid, source, {
      fileExists: () => true,
      readEvidence: () => 'test.skip("security", () => {});',
    }).some((message) => message.includes('skipped/focused')),
  );
  console.log(
    'Ledger self-test passed: extraction, pending release rejection, missing evidence, missing requirements, traversal, failed command, source drift, runtime stub, skipped test.',
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const command = process.argv[2] ?? 'check';
  if (command === '--self-test') selfTest();
  else {
    if (!['generate', 'check', 'release'].includes(command))
      throw new Error(
        'Usage: node scripts/ledger.mjs generate|check|release|--self-test',
      );
    const source = readFileSync(resolve(root, sourcePath), 'utf8');
    const ledger =
      command === 'generate'
        ? generate(source)
        : JSON.parse(readFileSync(resolve(root, ledgerPath), 'utf8'));
    const errors = validateLedger(ledger, source, {
      release: command === 'release',
    });
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else
      console.log(
        'Ledger valid: ' +
          ledger.features.length +
          ' requirements; ' +
          ledger.features.filter((item) => item.state === 'Done').length +
          ' Done. This is not release acceptance.',
      );
  }
}
