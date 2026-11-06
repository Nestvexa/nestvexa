// Generates browser/generated/actions-client.{js,d.ts} from the server's
// @ActionGroup classes using the public @nestvexa/actions/codegen API.
import { fileURLToPath } from 'node:url';
import {
  formatDiagnostic,
  generateActionClient,
} from '@nestvexa/actions/codegen';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = await generateActionClient({
  project: `${root}tsconfig.json`,
  outDir: `${root}browser/generated`,
  // Live/HBS element helpers bind the server-rendered buttons.
  targets: ['live'],
});
for (const diagnostic of result.diagnostics)
  console.error(formatDiagnostic(diagnostic));
if (!result.ok) process.exit(1);
console.log(
  `Generated typed actions client for ${result.groups.map((group) => group.id).join(', ')}`,
);
