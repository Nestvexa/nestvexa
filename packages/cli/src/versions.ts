/**
 * Exact third-party versions the generators add to a project. They are the
 * versions this repository builds and tests its examples with;
 * `tests/cli-generators.test.ts` fails when an example moves to another version
 * without this table following. First-party packages use `^<CLI version>`.
 */
export const pinned = Object.freeze({
  '@fastify/cookie': '11.1.5',
  '@fastify/session': '11.1.6',
  '@inertiajs/core': '3.10.0',
  '@inertiajs/react': '3.10.0',
  '@inertiajs/svelte': '3.10.0',
  '@inertiajs/vue3': '3.10.0',
  '@jest/globals': '30.5.2',
  '@nestjs/testing': '12.2.0',
  '@nestjs/typeorm': '12.0.2',
  '@sveltejs/vite-plugin-svelte': '7.3.1',
  '@types/express-session': '1.19.0',
  '@types/react': '19.3.0',
  '@types/react-dom': '19.3.0',
  '@vitejs/plugin-react': '6.1.2',
  '@vitejs/plugin-vue': '6.0.10',
  'class-transformer': '0.5.1',
  'class-validator': '0.15.1',
  'express-session': '1.19.0',
  react: '19.3.1',
  'react-dom': '19.3.1',
  svelte: '5.57.3',
  'svelte-check': '4.7.7',
  typeorm: '1.1.2',
  vite: '8.3.5',
  vitest: '5.0.5',
  vue: '3.5.44',
  'vue-tsc': '3.3.14',
  ws: '8.22.0',
  zod: '4.6.7',
});
export type PinnedPackage = keyof typeof pinned;

/** `{ name: version }` for a list of pinned third-party packages. */
export function pins(
  ...names: readonly PinnedPackage[]
): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, pinned[name]]));
}
