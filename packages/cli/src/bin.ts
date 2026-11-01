#!/usr/bin/env node
import { run } from './index.js';

const output = run(process.argv.slice(2));
for (const line of output.stdout) process.stdout.write(line + '\n');
for (const line of output.stderr) process.stderr.write(line + '\n');
process.exitCode = output.exitCode;
