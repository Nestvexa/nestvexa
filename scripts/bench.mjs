// Reproducible performance measurements (QA-003, QA-005, QA-010, QA-013).
//
//   pnpm build && pnpm exec playwright install chromium && pnpm bench
//
// Every server runs in its own process (tests/bench/server.ts through tsx,
// with --expose-gc); this process generates the load, so load generation
// never shares the measured event loop. Scenarios:
//
//   hbs-adapter     cached HbsEngine render in isolation (p50/p95/p99)
//   cold-render     boot time, first request after boot and warm requests:
//                   Nestvexa MVC vs plain NestJS + Handlebars
//   ssr-throughput  autocannon on the same 50-row page: Nestvexa MVC vs plain
//                   NestJS + Handlebars, @nestvexa/inertia vs an
//                   official-style Inertia responder (HTML and X-Inertia JSON)
//   noop-action     Live no-op action vs a plain Nest JSON POST route
//   bytes           serialized bytes (raw and gzip) of a Live mount, action
//                   replies and Inertia pages for 10/100/1000 rows
//   components      10/100/1000 concurrently active Live components: mount
//                   wave, one action each (<= 100 connections), heap per component
//   dom-patch       morphChildren time for 100/1000/5000 keyed rows (Chromium)
//
// Environment (optional): BENCH_SCENARIOS (comma list, default all),
// BENCH_DURATION_SECONDS (default 10), BENCH_CONNECTIONS (default 10),
// BENCH_PORT (default 4210; the DOM fixture uses BENCH_PORT + 1).
// Writes artifacts/reports/benchmark.json. The numbers are host-specific
// measurements for comparing runs and targets, never performance promises;
// the report records host, Node and browser versions for reproduction.
import autocannon from 'autocannon';
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { clearInterval, setInterval } from 'node:timers';
import { gzipSync } from 'node:zlib';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';

const all = [
  'hbs-adapter',
  'cold-render',
  'ssr-throughput',
  'noop-action',
  'bytes',
  'components',
  'dom-patch',
];
const selected = (process.env.BENCH_SCENARIOS ?? all.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
for (const name of selected)
  if (!all.includes(name)) throw new Error(`Unknown bench scenario ${name}`);
const duration = Number(process.env.BENCH_DURATION_SECONDS ?? 10);
const connections = Number(process.env.BENCH_CONNECTIONS ?? 10);
const port = Number(process.env.BENCH_PORT ?? 4210);
for (const [name, value] of Object.entries({ duration, connections, port }))
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_534)
    throw new Error(`Invalid bench setting ${name}`);
const base = `http://127.0.0.1:${port}`;
// Fixed bench identity values, also hard-coded in tests/bench/server.ts.
const csrf = 'bench-csrf-token-0123456789abcdefghijklmnop';
const inertiaVersion = 'bench-1';

const round = (value, digits = 2) => Number(value.toFixed(digits));
function summary(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction) =>
    sorted.length
      ? round(
          sorted[
            Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
          ],
        )
      : 0;
  return { samples: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

/** Start one benchmark server process and wait until it listens. */
async function server(target) {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    ['--expose-gc', '--import', 'tsx', 'tests/bench/server.ts'],
    {
      env: { ...process.env, BENCH_TARGET: target, BENCH_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  await new Promise((resolve, reject) => {
    const fail = (message) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail(`${target} did not start: ${output}`),
      180_000,
    );
    const poll = setInterval(() => {
      if (!output.includes(`bench:${target}:ready`)) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    }, 20);
    child.once('exit', (code) =>
      fail(`${target} exited with ${code}: ${output}`),
    );
  });
  return {
    bootMs: round(performance.now() - started),
    async heap() {
      const response = await fetch(`${base}/__bench/heap`);
      return (await response.json()).heapUsed;
    },
    async stop() {
      child.removeAllListeners('exit');
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    },
  };
}
async function withServer(target, work) {
  const running = await server(target);
  try {
    return await work(running);
  } finally {
    await running.stop();
  }
}
async function timed(url, init) {
  const start = performance.now();
  const response = await fetch(url, init);
  const body = await response.text();
  return { ms: performance.now() - start, status: response.status, body };
}
async function cannon(url, headers = {}) {
  const result = await autocannon({ url, connections, duration, headers });
  if (result.errors || result.timeouts || result.non2xx)
    throw new Error(
      `Load errors on ${url}: ${result.errors} errors, ${result.timeouts} timeouts, ${result.non2xx} non-2xx`,
    );
  return {
    requestsPerSecond: round(result.requests.average, 1),
    latencyMs: {
      p50: result.latency.p50,
      p97_5: result.latency.p97_5,
      p99: result.latency.p99,
    },
    bytesPerResponse: Math.round(
      result.throughput.total / result.requests.total,
    ),
  };
}

// --- scenarios -------------------------------------------------------------

async function hbsAdapter() {
  const engine = new HbsEngine({
    root: 'examples/starter-hbs/views',
    cache: true,
  });
  await engine.initialize();
  const samples = [];
  for (let index = 0; index < 1100; index++) {
    const start = performance.now();
    await engine.render('home', {
      title: 'Benchmark',
      message: 'hello',
      example: '<escape>',
    });
    if (index >= 100) samples.push(performance.now() - start);
  }
  await engine.dispose();
  return {
    scope: 'cached HbsEngine render of examples/starter-hbs home, in process',
    milliseconds: summary(samples),
  };
}

async function coldRender() {
  const result = {};
  for (const target of ['nestvexa-hbs', 'plain-hbs'])
    result[target] = await withServer(target, async (running) => {
      const first = await timed(`${base}/page?rows=50`);
      if (first.status !== 200) throw new Error(`${target} page failed`);
      const warm = [];
      for (let index = 0; index < 200; index++)
        warm.push((await timed(`${base}/page?rows=50`)).ms);
      return {
        bootMs: running.bootMs,
        firstRequestMs: round(first.ms),
        warmMs: summary(warm),
      };
    });
  return {
    scope:
      'process start until listening, the first request after boot (templates not yet compiled) and 200 sequential warm requests of the 50-row page',
    ...result,
  };
}

async function ssrThroughput() {
  const result = {};
  for (const target of ['nestvexa-hbs', 'plain-hbs'])
    result[target] = await withServer(target, () =>
      cannon(`${base}/page?rows=50`),
    );
  for (const target of ['nestvexa-inertia', 'plain-inertia'])
    result[target] = await withServer(target, async () => ({
      html: await cannon(`${base}/page?rows=50`),
      json: await cannon(`${base}/page?rows=50`, {
        'x-inertia': 'true',
        'x-inertia-version': inertiaVersion,
      }),
    }));
  return {
    scope: `autocannon, ${connections} connections for ${duration}s per target and visit kind, the same 50-row model and templates`,
    ...result,
  };
}

/** Mount one Live list for a user and return its reference from the markup. */
async function mountList(user, rows) {
  const response = await fetch(`${base}/live?rows=${rows}`, {
    headers: { 'x-bench-user': user },
  });
  const html = await response.text();
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
  const revision = Number(/data-nv-revision="(\d+)"/.exec(html)?.[1]);
  if (!snapshot || !Number.isSafeInteger(revision))
    throw new Error(`Live mount failed (${response.status})`);
  return { user, snapshot, revision, html };
}
async function act(reference, action) {
  const start = performance.now();
  const response = await fetch(`${base}/_nestvexa/live/bench-list/${action}`, {
    method: 'POST',
    headers: {
      origin: base,
      'content-type': 'application/json',
      'x-nestvexa-csrf': csrf,
      'x-bench-user': reference.user,
    },
    body: JSON.stringify({
      protocol: 'nestvexa-live/1',
      requestId: randomUUID(),
      snapshot: reference.snapshot,
      revision: reference.revision,
      updates: {},
    }),
  });
  const body = await response.text();
  const ms = performance.now() - start;
  if (response.status !== 201)
    throw new Error(`Live ${action} failed: ${response.status} ${body}`);
  const reply = JSON.parse(body);
  reference.revision = reply.component.revision;
  reference.snapshot = reply.snapshot ?? reference.snapshot;
  return { ms, body };
}
/** `workers` sequential clients for `seconds`; returns request latencies. */
async function clients(workers, seconds, setup, run) {
  const samples = [];
  const states = await Promise.all(
    Array.from({ length: workers }, (_, worker) => setup(worker)),
  );
  const end = performance.now() + seconds * 1000;
  await Promise.all(
    states.map(async (state) => {
      while (performance.now() < end) samples.push(await run(state));
    }),
  );
  return {
    requestsPerSecond: round(samples.length / seconds, 1),
    latencyMs: summary(samples),
  };
}

async function noopAction() {
  const live = await withServer('nestvexa-hbs', () =>
    clients(
      connections,
      duration,
      (worker) => mountList(`noop-${worker}`, 10),
      async (reference) => (await act(reference, 'noop')).ms,
    ),
  );
  const plain = await withServer('plain-hbs', () =>
    clients(
      connections,
      duration,
      () => ({ revision: 0 }),
      async (state) => {
        const start = performance.now();
        const response = await fetch(`${base}/noop`, {
          method: 'POST',
          headers: { origin: base, 'content-type': 'application/json' },
          body: JSON.stringify({ revision: state.revision }),
        });
        state.revision = (await response.json()).revision;
        return performance.now() - start;
      },
    ),
  );
  return {
    scope: `${connections} sequential clients for ${duration}s; Live: one component per client (10-row state) calling a no-op action through the full pipeline (CSRF, origin, identity, store transaction, render); plain: a Nest JSON POST route`,
    'nestvexa-live-noop': live,
    'plain-nest-post': plain,
  };
}

async function bytes() {
  const sizes = (text) => ({
    bytes: Buffer.byteLength(text),
    gzipBytes: gzipSync(text).byteLength,
  });
  const result = {};
  await withServer('nestvexa-hbs', async () => {
    for (const rows of [10, 100, 1000]) {
      let reference;
      try {
        reference = await mountList(`bytes-${rows}`, rows);
      } catch (error) {
        // Live state is bounded (LIVE_LIMITS); record the refusal itself.
        result[`live-${rows}`] = { refused: error.message };
        continue;
      }
      const noop = await act(reference, 'noop');
      const touch = await act(reference, 'touch');
      result[`live-${rows}`] = {
        mountHtml: sizes(reference.html),
        noopReply: sizes(noop.body),
        touchReply: sizes(touch.body),
      };
    }
  });
  await withServer('nestvexa-inertia', async () => {
    for (const rows of [10, 100, 1000])
      result[`inertia-${rows}`] = {
        jsonPage: sizes(
          (
            await timed(`${base}/page?rows=${rows}`, {
              headers: {
                'x-inertia': 'true',
                'x-inertia-version': inertiaVersion,
              },
            })
          ).body,
        ),
        htmlPage: sizes((await timed(`${base}/page?rows=${rows}`)).body),
      };
  });
  await withServer('plain-hbs', async () => {
    for (const rows of [10, 100, 1000])
      result[`plain-hbs-${rows}`] = {
        htmlPage: sizes((await timed(`${base}/page?rows=${rows}`)).body),
      };
  });
  return {
    scope:
      'response bodies as sent (no compression middleware) and their gzip size; the Live list keeps N rows in state and renders them',
    ...result,
  };
}

async function components() {
  const result = {};
  for (const count of [10, 100, 1000])
    result[count] = await withServer('nestvexa-hbs', async (running) => {
      const before = await running.heap();
      const mountStart = performance.now();
      const references = [];
      // Mount in waves of 50 concurrent page requests, one user each.
      for (let index = 0; index < count; index += 50)
        references.push(
          ...(await Promise.all(
            Array.from({ length: Math.min(50, count - index) }, (_, offset) =>
              mountList(`user-${index + offset}`, 10),
            ),
          )),
        );
      const mountMs = performance.now() - mountStart;
      const mounted = await running.heap();
      // Every component acts in one wave, through at most 100 concurrent
      // client connections (more simultaneous connects overflow the listen
      // backlog on Windows hosts).
      const actionStart = performance.now();
      const latencies = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(100, references.length) }, async () => {
          while (next < references.length) {
            const reference = references[next++];
            latencies.push((await act(reference, 'touch')).ms);
          }
        }),
      );
      return {
        mountWaveMs: round(mountMs),
        concurrentActionWaveMs: round(performance.now() - actionStart),
        actionLatencyMs: summary(latencies),
        heapPerComponentBytes: Math.round((mounted - before) / count),
      };
    });
  return {
    scope:
      'N users each mount one Live list (10 rows) in waves of 50, then all N call one action in one wave over at most 100 concurrent connections; heap measured after forced GC with the default MemoryLiveStore',
    ...result,
  };
}

async function domPatch() {
  const fixture = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<!doctype html><html lang="en"><title>bench</title><script type="module">import * as morph from "/morph.js"; globalThis.nvMorph = morph;</script><main></main></html>',
      );
      return;
    }
    // Built client modules only; nothing else is served.
    if (!/^\/[a-z-]+\.js$/.test(pathname)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const source = await readFile(
        new URL(`../packages/client/dist${pathname}`, import.meta.url),
        'utf8',
      );
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(source);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) =>
    fixture.listen(port + 1, '127.0.0.1', resolve),
  );
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port + 1}/`);
    await page.waitForFunction(() => 'nvMorph' in globalThis);
    const result = { browser: `chromium ${browser.version()}` };
    for (const rows of [100, 1000, 5000])
      result[rows] = await page.evaluate((count) => {
        const row = (index, version) =>
          `<tr data-nv-key="r${index}"><td>${index}</td><td>Item ${index} v${version}</td><td><input type="checkbox" aria-label="Select ${index}"${version ? ' checked' : ''}></td></tr>`;
        const markup = (version) =>
          Array.from({ length: count }, (_, index) => row(index, version)).join(
            '',
          );
        const before = markup(0);
        const after = markup(1);
        const main = globalThis.document.querySelector('main');
        const samples = [];
        for (let run = 0; run < 11; run++) {
          main.innerHTML = `<table><tbody>${before}</tbody></table>`;
          const parent = main.querySelector('tbody');
          const template = globalThis.document.createElement('template');
          template.innerHTML = after;
          const start = performance.now();
          globalThis.nvMorph.morphChildren(parent, template.content, new Map());
          if (run) samples.push(performance.now() - start);
        }
        samples.sort((left, right) => left - right);
        return {
          medianMs: Number(samples[5].toFixed(2)),
          maxMs: Number(samples[9].toFixed(2)),
        };
      }, rows);
    return {
      scope:
        'built morphChildren updating every row of a keyed table (text and a selection checkbox per row), median of 10 runs after one warm-up',
      ...result,
    };
  } finally {
    await browser.close();
    await new Promise((resolve) => fixture.close(resolve));
  }
}

const scenarios = {
  'hbs-adapter': hbsAdapter,
  'cold-render': coldRender,
  'ssr-throughput': ssrThroughput,
  'noop-action': noopAction,
  bytes,
  components,
  'dom-patch': domPatch,
};
const report = {
  timestamp: new Date().toISOString(),
  node: process.version,
  platform: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model,
  cpuCount: cpus().length,
  totalMemoryBytes: totalmem(),
  freeMemoryBytesAtStart: freemem(),
  settings: { duration, connections, port, scenarios: selected },
  note: 'Host-specific measurements for comparing runs and targets; not performance promises.',
  scenarios: {},
};
for (const name of selected) {
  const started = performance.now();
  console.log(`bench: ${name}`);
  report.scenarios[name] = await scenarios[name]();
  console.log(
    `bench: ${name} done in ${round((performance.now() - started) / 1000, 1)} s`,
  );
}
await mkdir('artifacts/reports', { recursive: true });
await writeFile(
  'artifacts/reports/benchmark.json',
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
