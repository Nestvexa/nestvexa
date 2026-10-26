import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';

const engine = new HbsEngine({
  root: 'examples/starter-hbs/views',
  cache: true,
});
await engine.initialize();
const samples = [];
for (let i = 0; i < 1100; i++) {
  const start = performance.now();
  await engine.render('home', {
    title: 'Benchmark',
    message: 'hello',
    example: '<escape>',
  });
  if (i >= 100) samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
await engine.dispose();
const result = {
  timestamp: new Date().toISOString(),
  node: process.version,
  platform: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model,
  iterations: samples.length,
  scope: 'cached HBS adapter only; not end-to-end or a plain-Nest comparison',
  milliseconds: { p50: samples[500], p95: samples[950], p99: samples[990] },
};
await mkdir('artifacts/reports', { recursive: true });
await writeFile(
  'artifacts/reports/benchmark.json',
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
