#!/usr/bin/env node
/** Delegates to the optional @nestvexa/cli package so the default install stays small. */
try {
  const { run } =
    (await import('@nestvexa/cli')) as typeof import('@nestvexa/cli');
  const output = run(process.argv.slice(2));
  for (const line of output.stdout) process.stdout.write(line + '\n');
  for (const line of output.stderr) process.stderr.write(line + '\n');
  process.exitCode = output.exitCode;
} catch (error) {
  const code: unknown =
    error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  if (code !== 'ERR_MODULE_NOT_FOUND') throw error;
  process.stderr.write(
    'The nestvexa command needs @nestvexa/cli. Install it with: npm install --save-dev @nestvexa/cli\n',
  );
  process.exitCode = 1;
}
