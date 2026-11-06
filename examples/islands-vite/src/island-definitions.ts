import type { IslandBuildDefinition } from '@nestvexa/islands/build';

const counterProps = {
  type: 'object',
  properties: {
    label: { type: 'string', maxLength: 40 },
    start: { type: 'integer', minimum: 0, maximum: 1000 },
  },
  required: ['label', 'start'],
} as const;

/**
 * The single source of island definitions: the Vite build turns them into
 * the manifest (server registry + browser allowlist) and the analysis, and
 * the dev server builds its registry from them directly.
 */
export const islandDefinitions: readonly IslandBuildDefinition[] = [
  {
    id: 'counter-react',
    framework: 'react',
    strategy: 'immediate',
    entry: 'client/islands/counter-react.tsx',
    budgetBytes: 80_000,
    props: counterProps,
  },
  {
    id: 'counter-vue',
    framework: 'vue',
    strategy: 'visible',
    entry: 'client/islands/counter-vue.ts',
    budgetBytes: 45_000,
    props: counterProps,
  },
  {
    id: 'counter-svelte',
    framework: 'svelte',
    strategy: 'idle',
    entry: 'client/islands/counter-svelte.ts',
    budgetBytes: 30_000,
    props: counterProps,
  },
];
