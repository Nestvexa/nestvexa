// Load, latency and memory-growth checks against the built starter-hbs and
// live-counter examples, plus an in-process realtime hub churn check.
//
//   pnpm build && pnpm load
//
// Environment (all optional):
//   LOAD_PORT_BASE         first port (default 3320; uses base and base+1)
//   LOAD_DURATION_SECONDS  throughput phase per scenario (default 15)
//   LOAD_SOAK_MINUTES      Live action soak used for memory growth (default 1)
//   LOAD_CONNECTIONS       concurrent connections (default 10)
//   LOAD_LIVE_SESSIONS     distinct Live sessions in the action pool (default 400)
//   LOAD_LATENCY_GATE      `enforce` (default) or `advisory`
//
// Writes artifacts/reports/load.json and exits 1 when any gate fails.
// Correctness under load (no errors, timeouts or unexpected statuses) and
// memory growth are always enforced. Throughput/p99 budgets are initial
// budgets for an otherwise idle 2+ core host; on a saturated shared machine
// run with LOAD_LATENCY_GATE=advisory, which records misses as advisories.
// They are not performance promises for other hardware.
//
// The live-counter example keeps its documented defaults: 60 requests per
// minute per identity and 1000 components per process. The action scenario
// therefore spreads requests over LOAD_LIVE_SESSIONS sessions at an offered
// rate of 80% of what those limits allow, and checks the rate is achieved.
import autocannon from 'autocannon';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

const root = process.cwd();
const base = Number(process.env.LOAD_PORT_BASE ?? 3320);
const duration = Number(process.env.LOAD_DURATION_SECONDS ?? 15);
const soakMinutes = Number(process.env.LOAD_SOAK_MINUTES ?? 1);
const connections = Number(process.env.LOAD_CONNECTIONS ?? 10);
const liveSessions = Number(process.env.LOAD_LIVE_SESSIONS ?? 400);
const latencyGate = process.env.LOAD_LATENCY_GATE ?? 'enforce';
for (const [name, value] of Object.entries({
  base,
  duration,
  soakMinutes,
  connections,
  liveSessions,
}))
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`Invalid load setting ${name}`);
if (liveSessions > 600)
  throw new Error('LOAD_LIVE_SESSIONS must stay below the 1000-entry store');
if (!['enforce', 'advisory'].includes(latencyGate))
  throw new Error('LOAD_LATENCY_GATE must be enforce or advisory');
// 60 actions per minute per identity, at 80% utilisation.
const liveOfferedRate = Math.floor(liveSessions * 0.8);

const MiB = 1024 * 1024;
const thresholds = Object.freeze({
  'starter-hbs GET /': { minRequestsPerSecond: 150, maxP99Ms: 250 },
  'live-counter mount GET /': { minRequestsPerSecond: 30, maxP99Ms: 500 },
  'live-counter action POST increment': {
    // The offered rate is fixed; the server must keep up with it.
    minRequestsPerSecond: Math.floor(liveOfferedRate * 0.9),
    maxP99Ms: 300,
  },
  // Heap growth between post-warm-up and end-of-soak samples, after full GC.
  serverHeapGrowthBytes: 24 * MiB,
  realtimeHeapGrowthBytes: 8 * MiB,
});

const report = {
  timestamp: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpus: os.cpus()[0]?.model ?? 'unknown',
  cpuCount: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  config: {
    base,
    duration,
    soakMinutes,
    connections,
    liveSessions,
    liveOfferedRate,
    latencyGate,
  },
  thresholds,
  scenarios: [],
  memory: [],
  realtimeHub: undefined,
  failures: [],
  advisories: [],
  passed: false,
};

function fail(message) {
  report.failures.push(message);
  console.error(`FAIL ${message}`);
}
function performanceMiss(message) {
  if (latencyGate === 'enforce') return fail(message);
  report.advisories.push(message);
  console.warn(`ADVISORY ${message}`);
}

/** Start a built example with the memory probe preloaded; never via a shell. */
async function startServer(name, port) {
  const cwd = resolve(root, 'examples', name);
  const child = fork(resolve(cwd, 'dist/main.js'), [], {
    cwd,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
    execArgv: [
      '--expose-gc',
      '--import',
      pathToFileURL(resolve(root, 'scripts/load-probe.mjs')).href,
    ],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`${name} exited during startup:\n${output}`);
    try {
      const response = await fetch(`${url}/api/health`, { redirect: 'manual' });
      await response.arrayBuffer();
      if (response.status < 500) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline)
      throw new Error(`${name} did not start on ${url}:\n${output}`);
    await new Promise((done) => setTimeout(done, 250));
  }
  let sequence = 0;
  return {
    url,
    output: () => output,
    sample() {
      const id = ++sequence;
      return new Promise((resolveSample, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${name} memory sample timed out`)),
          10_000,
        );
        const listener = (message) => {
          if (message?.type !== 'nestvexa-load-sample' || message.id !== id)
            return;
          clearTimeout(timer);
          child.off('message', listener);
          const { heapUsed, rss, external, arrayBuffers } = message;
          resolveSample({
            at: Date.now(),
            heapUsed,
            rss,
            external,
            arrayBuffers,
          });
        };
        child.on('message', listener);
        child.send({ type: 'nestvexa-load-sample', id });
      });
    },
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

function summarize(name, result, extra = {}) {
  const scenario = {
    name,
    durationSeconds: result.duration,
    connections: result.connections,
    requestsTotal: result.requests.total,
    requestsPerSecond: Math.round(result.requests.average),
    latencyMs: {
      p50: result.latency.p50,
      p90: result.latency.p90,
      p99: result.latency.p99,
      max: result.latency.max,
    },
    throughputBytesPerSecond: Math.round(result.throughput.average),
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
    ...extra,
    threshold: thresholds[name],
    passed: true,
  };
  const limit = thresholds[name];
  const problems = [];
  if (scenario.errors || scenario.timeouts)
    problems.push(`${scenario.errors} errors, ${scenario.timeouts} timeouts`);
  if (scenario.non2xx) problems.push(`${scenario.non2xx} non-2xx responses`);
  if (problems.length) {
    scenario.passed = false;
    fail(`${name}: ${problems.join('; ')}`);
  }
  const misses = [];
  if (limit && scenario.requestsPerSecond < limit.minRequestsPerSecond)
    misses.push(
      `${scenario.requestsPerSecond} req/s < ${limit.minRequestsPerSecond}`,
    );
  if (limit && scenario.latencyMs.p99 > limit.maxP99Ms)
    misses.push(`p99 ${scenario.latencyMs.p99} ms > ${limit.maxP99Ms} ms`);
  scenario.performanceWithinBudget = misses.length === 0;
  if (misses.length) {
    if (latencyGate === 'enforce') scenario.passed = false;
    performanceMiss(`${name}: ${misses.join('; ')}`);
  }
  report.scenarios.push(scenario);
  console.log(
    `${name}: ${scenario.requestsPerSecond} req/s, p50 ${scenario.latencyMs.p50} ms, p99 ${scenario.latencyMs.p99} ms, non-2xx ${scenario.non2xx}`,
  );
  return scenario;
}

function memoryVerdict(name, samples, limit) {
  const [warm] = samples;
  const last = samples.at(-1);
  const growth = last.heapUsed - warm.heapUsed;
  // Least-squares slope over all samples, in bytes per minute.
  const xs = samples.map((sample) => (sample.at - warm.at) / 60_000);
  const ys = samples.map((sample) => sample.heapUsed);
  const mean = (values) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const mx = mean(xs);
  const my = mean(ys);
  const denominator = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  const slope = denominator
    ? xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index] - my), 0) /
      denominator
    : 0;
  const entry = {
    name,
    samples,
    heapGrowthBytes: growth,
    heapSlopeBytesPerMinute: Math.round(slope),
    rssGrowthBytes: last.rss - warm.rss,
    maxHeapGrowthBytes: limit,
    passed: growth <= limit,
  };
  report.memory.push(entry);
  console.log(
    `${name}: heap ${(warm.heapUsed / MiB).toFixed(1)} → ${(last.heapUsed / MiB).toFixed(1)} MiB (growth ${(growth / MiB).toFixed(2)} MiB, slope ${(slope / MiB).toFixed(2)} MiB/min)`,
  );
  if (!entry.passed)
    fail(
      `${name}: heap grew ${(growth / MiB).toFixed(2)} MiB > ${(limit / MiB).toFixed(0)} MiB`,
    );
}

async function starterHbs() {
  const server = await startServer('starter-hbs', base);
  try {
    // Warm-up, then measure throughput and heap before/after an equal-length run.
    await autocannon({ url: `${server.url}/`, connections, duration: 3 });
    const samples = [await server.sample()];
    const result = await autocannon({
      url: `${server.url}/`,
      connections,
      duration,
    });
    samples.push(await server.sample());
    summarize('starter-hbs GET /', result);
    memoryVerdict(
      'starter-hbs heap across throughput run',
      samples,
      thresholds.serverHeapGrowthBytes,
    );
  } finally {
    await server.stop();
  }
}

function cookieOf(response) {
  const header = response.headers.getSetCookie?.() ?? [];
  return header.map((value) => value.split(';', 1)[0]).join('; ');
}
function attribute(html, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(html);
  if (!match) throw new Error(`Live markup lacks ${name}`);
  return match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}
async function liveSession(url) {
  const response = await fetch(`${url}/`);
  const html = await response.text();
  if (response.status !== 200)
    throw new Error(`Live page returned ${response.status}`);
  return {
    cookie: cookieOf(response),
    snapshot: attribute(html, 'data-nv-snapshot'),
    revision: Number(attribute(html, 'data-nv-revision')),
    csrf: attribute(html, 'data-nv-csrf'),
    endpoint: attribute(html, 'data-nv-endpoint'),
  };
}

async function liveCounter() {
  const server = await startServer('live-counter', base + 1);
  try {
    // Mount throughput: every request is a new guest session (one mount, one
    // identity each), bounded well below the 1000-entry store and rate maps.
    const mount = await autocannon({
      url: `${server.url}/`,
      connections,
      amount: 300,
    });
    summarize('live-counter mount GET /', mount, {
      note: '300 fresh sessions; default MemoryLiveStore capacity is 1000 per TTL',
    });
    const sessions = [];
    for (let index = 0; index < liveSessions; index++)
      sessions.push(await liveSession(server.url));
    // A free list keeps each snapshot strictly serial: a session is never in
    // flight twice, so every response must be the next revision (no 409s).
    const free = [...sessions];
    let rejected = 0;
    const statuses = {};
    const action = (seconds) =>
      autocannon({
        url: server.url,
        connections,
        duration: seconds,
        overallRate: liveOfferedRate,
        requests: [
          {
            method: 'POST',
            setupRequest(request, context) {
              const session = free.shift();
              if (!session) throw new Error('Live session pool exhausted');
              context.session = session;
              return {
                ...request,
                path: `${session.endpoint}/increment`,
                headers: {
                  'content-type': 'application/json',
                  'x-nestvexa-csrf': session.csrf,
                  origin: server.url,
                  cookie: session.cookie,
                },
                body: JSON.stringify({
                  protocol: 'nestvexa-live/1',
                  requestId: randomUUID(),
                  snapshot: session.snapshot,
                  revision: session.revision,
                  updates: {},
                }),
              };
            },
            onResponse(status, body, context) {
              const session = context.session;
              statuses[status] = (statuses[status] ?? 0) + 1;
              if (status >= 200 && status < 300) {
                const payload = JSON.parse(body);
                session.snapshot = payload.snapshot;
                session.revision = payload.component.revision;
              } else rejected++;
              free.push(session);
            },
          },
        ],
      });
    await action(3);
    const samples = [await server.sample()];
    const throughput = await action(duration);
    summarize('live-counter action POST increment', throughput, {
      offeredRequestsPerSecond: liveOfferedRate,
      sessions: liveSessions,
    });
    const soakEnd = Date.now() + soakMinutes * 60_000;
    let soakRequests = 0;
    while (Date.now() < soakEnd) {
      const result = await action(
        Math.max(1, Math.min(10, Math.round((soakEnd - Date.now()) / 1000))),
      );
      soakRequests += result.requests.total;
      if (result.errors || result.timeouts || result.non2xx)
        fail(
          `live-counter soak: ${result.errors} errors, ${result.timeouts} timeouts, ${result.non2xx} non-2xx`,
        );
      samples.push(await server.sample());
    }
    report.scenarios.at(-1).soakRequests = soakRequests;
    report.scenarios.at(-1).statuses = statuses;
    memoryVerdict(
      `live-counter heap across ${soakMinutes} min action soak`,
      samples,
      thresholds.serverHeapGrowthBytes,
    );
    if (rejected) fail(`live-counter: ${rejected} rejected action responses`);
  } finally {
    await server.stop();
  }
}

async function realtimeHub() {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const { MemoryRealtimeBroker, RealtimeHub, createTokenSigner } = await import(
    pathToFileURL(resolve(root, 'packages/realtime/dist/index.js')).href
  );
  const broker = new MemoryRealtimeBroker({ replaySize: 10 });
  const signer = createTokenSigner({ secrets: ['load-test-secret'.repeat(4)] });
  const hub = new RealtimeHub(
    broker,
    signer,
    { authorizeChannel: () => true },
    {
      maxConnections: 10_000,
      maxConnectionsPerIdentity: 8,
      queueLimit: 64,
      heartbeatMs: 60_000,
      revalidateMs: 60_000,
    },
  );
  let delivered = 0;
  const sink = () => ({
    send: () => {
      delivered++;
      return true;
    },
    heartbeat: () => undefined,
    close: () => undefined,
  });
  const cycle = async (round, count) => {
    const open = [];
    for (let index = 0; index < count; index++) {
      const binding = `load-identity-${round}-${index}`.padEnd(24, '-');
      const channels = [`user:${round}:${index}`, 'shared:feed'];
      const token = signer.sign(binding, channels);
      open.push(await hub.connect(() => ({ binding }), [token], sink()));
    }
    for (let index = 0; index < count; index += 10)
      await broker.publish(`user:${round}:${index}`, { index });
    await broker.publish('shared:feed', { round });
    await new Promise((done) => setTimeout(done, 0));
    for (const connection of open) connection.close();
  };
  const heap = () => {
    gc();
    gc();
    return process.memoryUsage().heapUsed;
  };
  for (let round = 0; round < 5; round++) await cycle(`warm${round}`, 500);
  const before = heap();
  const rounds = 40;
  for (let round = 0; round < rounds; round++) await cycle(round, 500);
  await new Promise((done) => setTimeout(done, 50));
  const after = heap();
  const result = {
    connectCycles: rounds * 500,
    delivered,
    openConnectionsAfter: hub.size,
    brokerSubscriptionsAfter: broker.subscriptions,
    replayChannelsAfter: broker.replayChannels,
    heapGrowthBytes: after - before,
    maxHeapGrowthBytes: thresholds.realtimeHeapGrowthBytes,
    passed:
      hub.size === 0 &&
      broker.subscriptions === 0 &&
      after - before <= thresholds.realtimeHeapGrowthBytes,
  };
  report.realtimeHub = result;
  console.log(
    `realtime hub: ${result.connectCycles} connect/close cycles, ${delivered} deliveries, open after ${hub.size}, heap growth ${(result.heapGrowthBytes / MiB).toFixed(2)} MiB`,
  );
  if (!result.passed)
    fail(
      `realtime hub leak check: open ${hub.size}, subscriptions ${broker.subscriptions}, heap growth ${(result.heapGrowthBytes / MiB).toFixed(2)} MiB`,
    );
  hub.shutdown();
  await broker.close();
}

await mkdir('artifacts/reports', { recursive: true });
try {
  await realtimeHub();
  await starterHbs();
  await liveCounter();
  report.passed = report.failures.length === 0;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await writeFile(
    'artifacts/reports/load.json',
    JSON.stringify(report, null, 2),
  );
}
console.log(
  report.passed
    ? 'Load and memory thresholds passed; see artifacts/reports/load.json.'
    : 'Load or memory thresholds FAILED; see artifacts/reports/load.json.',
);
if (!report.passed) process.exitCode = 1;
