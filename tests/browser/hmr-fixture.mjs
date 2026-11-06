// Starts an Inertia example in Vite dev mode from a disposable copy, so the
// HMR browser tests (tests/browser/inertia-hmr.spec.ts) can edit page sources
// on disk without touching tracked files:
//
//   node tests/browser/hmr-fixture.mjs <react|vue|svelte>   (PORT from env)
//
// The copy lives in artifacts/hmr-inertia-<framework> (gitignored, two levels
// below the repository root like examples/*, so relative tsconfig `extends`
// still resolve) and reuses the example's node_modules through a junction.
// Its Home page is replaced by a probe page with local state and a marker the
// tests rewrite.
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frameworks = {
  react: { page: 'client/pages/Home.tsx', probe: reactProbe },
  vue: { page: 'client/pages/Home.vue', probe: vueProbe },
  svelte: { page: 'client/pages/Home.svelte', probe: svelteProbe },
};
const framework = process.argv[2] ?? '';
if (!Object.hasOwn(frameworks, framework))
  throw new Error(
    `Usage: hmr-fixture.mjs <${Object.keys(frameworks).join('|')}>`,
  );
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(repository, 'examples', `inertia-${framework}`);
const target = join(repository, 'artifacts', `hmr-inertia-${framework}`);

// Drop the previous junction first with non-recursive calls, so removing the
// copy can never descend into the example's real node_modules.
const link = join(target, 'node_modules');
if (lstatSafe(link)) {
  try {
    unlinkSync(link);
  } catch {
    rmdirSync(link);
  }
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  filter: (path) => {
    const name = path.slice(source.length).split(/[\\/]/)[1];
    return name !== 'node_modules' && name !== 'dist';
  },
});
symlinkSync(
  join(source, 'node_modules'),
  join(target, 'node_modules'),
  'junction',
);
const { page, probe } = frameworks[framework];
writeFileSync(join(target, page), probe('[[hmr:baseline]]'));

const cli = join(target, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!existsSync(cli)) throw new Error(`tsx is not installed for ${source}`);
const child = spawn(process.execPath, [cli, 'src/main.ts', '--dev'], {
  cwd: target,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development' },
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));

function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
function reactProbe(marker) {
  return `import { Head } from '@inertiajs/react';
import { useState } from 'react';

// HMR probe page (written by tests/browser/hmr-fixture.mjs).
export default function Home({ greeting }: { readonly greeting: string }) {
  const [count, setCount] = useState(0);
  return (
    <>
      <Head title="HMR probe" />
      <h1>{greeting}</h1>
      <p data-testid="hmr-marker">${marker}</p>
      <p data-testid="hmr-count">Count {count}</p>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Count up
      </button>
    </>
  );
}
`;
}
function vueProbe(marker) {
  return `<script setup lang="ts">
import { Head } from '@inertiajs/vue3';
import { ref } from 'vue';

// HMR probe page (written by tests/browser/hmr-fixture.mjs).
defineOptions({ inheritAttrs: false });
defineProps<{ greeting: string }>();
const count = ref(0);
</script>

<template>
  <Head title="HMR probe" />
  <h1>{{ greeting }}</h1>
  <p data-testid="hmr-marker">${marker}</p>
  <p data-testid="hmr-count">Count {{ count }}</p>
  <button type="button" @click="count++">Count up</button>
</template>
`;
}
function svelteProbe(marker) {
  return `<script lang="ts">
  // HMR probe page (written by tests/browser/hmr-fixture.mjs).
  let { greeting }: { greeting: string } = $props();
  let count = $state(0);
</script>

<svelte:head>
  <title>HMR probe</title>
</svelte:head>

<h1>{greeting}</h1>
<p data-testid="hmr-marker">${marker}</p>
<p data-testid="hmr-count">Count {count}</p>
<button type="button" onclick={() => (count += 1)}>Count up</button>
`;
}
