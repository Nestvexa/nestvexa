#!/usr/bin/env node
/**
 * Regenerates examples/cli-generated from scratch with the Nestvexa CLI.
 *
 *   node scripts/generate-cli-example.mjs [output-directory]
 *
 * The output starts as the smallest Nest (Express) application a developer
 * would have after `nest new`, then only CLI commands touch it. The single
 * post-processing step points the Nestvexa dependency ranges at the workspace
 * (`workspace:*`) so the example installs from this repository, and adds the
 * build/start scripts the repository's build and Playwright suite call.
 * tests/cli-example.test.ts reruns this script and diffs the result against
 * the committed example, so the example never drifts from the generators.
 * Requires `pnpm build` (packages/cli/dist).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(repo, 'examples', 'cli-generated'));
const { run } = await import(
  new URL('../packages/cli/dist/index.js', import.meta.url).href
);

/** Every CLI step, in order. The README lists the same commands. */
export const steps = [
  ['init'],
  ['make:page', 'Home'],
  ['make:page', 'Report-ejs', '--renderer', 'ejs'],
  ['make:page', 'Report-pug', '--renderer', 'pug'],
  ['make:page', 'Report-nunjucks', '--renderer', 'nunjucks'],
  ['make:page', 'React-dashboard', '--renderer', 'react'],
  ['make:page', 'Vue-dashboard', '--renderer', 'vue'],
  ['make:page', 'Svelte-dashboard', '--renderer', 'svelte'],
  ['make:form', 'Contact'],
  ['make:action', 'Greeter'],
  ['make:island', 'Clicker', '--renderer', 'react'],
  ['make:resource', 'Task', '--crud'],
  ['make:policy', 'Owner'],
  ['add', 'realtime'],
  ['add', 'uploads'],
  ['add', 'i18n'],
  ['migrate'],
];
/** Hand-written on top of the CLI output (see README): one page mounting the generated components. */
const showcaseController = `import { Controller, Get, Header, Inject, Render, Req } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { LiveRuntime } from 'nestvexa';
import { islands } from './nestvexa/islands.js';
import { ContactForm } from './nestvexa/forms/contact.form.js';
import { TaskTableComponent } from './task/task-table.component.js';

/**
 * The only hand-written file of this example: mounts the components generated
 * by make:form, make:resource and make:island on one page, as an application
 * would in its own controllers.
 */
@Controller('showcase')
export class ShowcaseController {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('showcase')
  async index(@Req() request: { session: Record<string, unknown> }) {
    request.session['csrf'] ??= randomBytes(32).toString('base64url');
    return {
      title: 'Showcase',
      contact: await this.live.mount(ContactForm, request),
      tasks: await this.live.mount(TaskTableComponent, request),
      clicker: islands.render('clicker', { label: 'Clicks' }, { key: 'clicker', label: 'Click counter' }),
    };
  }
}
`;
const showcaseView = `<h1>{{t "welcome"}} · {{title}}</h1>
<section aria-labelledby="contact-heading">
  <h2 id="contact-heading">Contact (make:form)</h2>
  {{contact}}
</section>
<section aria-labelledby="tasks-heading">
  <h2 id="tasks-heading">Tasks (make:resource --crud)</h2>
  {{tasks}}
</section>
<section aria-labelledby="island-heading">
  <h2 id="island-heading">React island (make:island)</h2>
  {{clicker}}
</section>
`;

// Start from an empty directory; installed dependencies and builds survive so
// a regeneration does not require a reinstall.
const keep = new Set(['node_modules', 'dist', 'storage', 'test-results']);
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out))
  if (!keep.has(entry))
    rmSync(join(out, entry), { recursive: true, force: true });

const write = (path, text) => {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  writeFileSync(join(out, path), text);
};
write(
  'package.json',
  JSON.stringify(
    {
      name: '@nestvexa/example-cli-generated',
      private: true,
      type: 'module',
      scripts: { build: 'tsc -p tsconfig.json' },
      dependencies: {
        '@nestjs/common': '12.2.0',
        '@nestjs/core': '12.2.0',
        '@nestjs/platform-express': '12.2.0',
        'reflect-metadata': '0.2.2',
        rxjs: '7.8.2',
      },
      devDependencies: { typescript: '6.0.3' },
    },
    null,
    2,
  ) + '\n',
);
write(
  'tsconfig.json',
  JSON.stringify(
    {
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2023',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true,
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        rootDir: '.',
        outDir: 'dist',
        types: ['node'],
      },
      include: ['src'],
    },
    null,
    2,
  ) + '\n',
);
write(
  'src/main.ts',
  `import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  await app.listen(Number(process.env['PORT'] ?? 3000), '127.0.0.1');
}
void bootstrap();
`,
);
write(
  'src/app.module.ts',
  `import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
`,
);
write(
  'src/app.controller.ts',
  `import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getHello(): string {
    return 'Hello World!';
  }
}
`,
);

for (const step of steps) {
  const result = run([...step, '--quiet'], out);
  if (result.exitCode !== 0) {
    console.error(
      `nestvexa ${step.join(' ')} failed:\n${[...result.stdout, ...result.stderr].join('\n')}`,
    );
    process.exit(1);
  }
}

// Post-processing: workspace dependencies and the scripts the repository calls.
const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'devDependencies'])
  for (const name of Object.keys(pkg[field] ?? {}))
    if (name === 'nestvexa' || name.startsWith('@nestvexa/'))
      pkg[field][name] = 'workspace:*';
pkg.scripts = {
  ...pkg.scripts,
  build: 'tsc -p tsconfig.json && npm run build:client',
  start: 'node dist/src/main.js',
};
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
write('src/showcase.controller.ts', showcaseController);
write('views/showcase.hbs', showcaseView);
const modulePath = join(out, 'src', 'app.module.ts');
const appModule = readFileSync(modulePath, 'utf8')
  .replace(
    "import { AppController } from './app.controller.js';",
    "import { AppController } from './app.controller.js';\nimport { ShowcaseController } from './showcase.controller.js';",
  )
  .replace(
    'controllers: [AppController,',
    'controllers: [AppController, ShowcaseController,',
  );
if (!appModule.includes('ShowcaseController,')) {
  console.error('Could not register ShowcaseController in src/app.module.ts');
  process.exit(1);
}
writeFileSync(modulePath, appModule);

write(
  'README.md',
  `# CLI-generated reference app

Generated by \`node scripts/generate-cli-example.mjs\`; **do not edit by hand**.
\`tests/cli-example.test.ts\` regenerates it and fails on any difference, so
this directory is exactly what the CLI produces today. The starting point is
the smallest Nest (Express) app (\`src/main.ts\`, \`src/app.module.ts\`,
\`src/app.controller.ts\`); every other file comes from these commands:

\`\`\`sh
${steps.map((step) => `nestvexa ${step.join(' ')}`).join('\n')}
\`\`\`

Post-processing (the only hand-written parts): the \`^0.1.0-alpha.0\` Nestvexa
ranges become \`workspace:*\`, \`build\`/\`start\` scripts are added, and
\`src/showcase.controller.ts\` + \`views/showcase.hbs\` (registered in
\`AppModule\`) mount the generated form, table and island on \`/showcase\`, as an
application would in its own controllers.

Check it after \`pnpm install\` with \`nestvexa doctor\` (development) and
\`nestvexa inspect:routes\`.

## Run

\`\`\`sh
pnpm build                                     # server, React/Vue/Svelte roots (client + SSR) and islands
NESTVEXA_ASSETS=build PORT=3126 pnpm --filter @nestvexa/example-cli-generated start
\`\`\`

\`NESTVEXA_ASSETS=build\` serves the built assets and server-renders the Inertia
roots in development (no Vite dev servers). Alternatively run
\`npm run dev:react\` (and \`dev:vue\`, \`dev:svelte\`) next to the server.

| Path | Generated by |
| ---- | ------------ |
| \`/nestvexa\` | \`init\` (Live counter) |
| \`/home\` | \`make:page Home\` (Handlebars) |
| \`/report-ejs\`, \`/report-pug\`, \`/report-nunjucks\` | \`make:page --renderer ejs\\|pug\\|nunjucks\` |
| \`/react-dashboard\`, \`/vue-dashboard\`, \`/svelte-dashboard\` | \`make:page --renderer react\\|vue\\|svelte\` (Inertia, SSR) |
| \`/showcase\` | Contact form (\`make:form\`), Task table (\`make:resource\`), Clicker island (\`make:island\`), \`{{t}}\` (\`add i18n\`) |
| \`/task\` | \`make:resource Task --crud\` (REST) |
| \`POST /_nestvexa/actions/greeter/greet\` | \`make:action Greeter\` |

\`tests/browser/cli-generated.spec.ts\` drives these pages in a real browser
(root Playwright suite, port 3126) and runs axe on them.
`,
);
if (!existsSync(join(out, '.nestvexa', 'manifest.json'))) {
  console.error('The CLI manifest is missing');
  process.exit(1);
}
console.log(`Generated ${out}`);
