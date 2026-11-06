// Generates client/generated/actions-client{,.react,.vue,.svelte}.{js,d.ts}
// from the server's @ActionGroup classes (typed hooks, composables, stores).
import { fileURLToPath } from 'node:url';
import {
  formatDiagnostic,
  generateActionClient,
} from '@nestvexa/actions/codegen';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = await generateActionClient({
  project: `${root}tsconfig.json`,
  outDir: `${root}client/generated`,
  targets: ['react', 'vue', 'svelte'],
});
for (const diagnostic of result.diagnostics)
  console.error(formatDiagnostic(diagnostic));
if (!result.ok) process.exit(1);
console.log(
  `Generated typed actions client for ${result.groups.map((group) => group.id).join(', ')}`,
);
