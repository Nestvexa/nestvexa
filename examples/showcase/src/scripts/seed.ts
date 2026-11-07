/**
 * `pnpm seed`: writes the deterministic sample data to the data directory
 * (`SHOWCASE_DATA_DIR`, default a per-port temp directory). Refuses to
 * overwrite existing data unless `--force` is passed. Stop the app first:
 * a running instance keeps its data in memory and rewrites the file.
 */
import { existsSync } from 'node:fs';
import { dataDirectory } from '../config.js';
import { dataFile, writeState } from '../data.js';
import { seedState } from '../seed.js';

const force = process.argv.includes('--force');
if (existsSync(dataFile) && !force) {
  console.error(
    `${dataFile} already exists. Run pnpm reset, or pnpm seed -- --force.`,
  );
  process.exitCode = 1;
} else {
  const state = seedState();
  writeState(state);
  console.log(
    `Seeded ${state.tasks.length} tasks and ${state.goals.length} goals into ${dataDirectory}`,
  );
}
