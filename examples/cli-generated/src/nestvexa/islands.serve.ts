import type { INestApplication } from '@nestjs/common';
import { viteStaticMiddleware } from '@nestvexa/vite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const directory = join(process.cwd(), 'dist/islands');

/**
 * Serves the islands bundle (`npm run build:islands`) under /islands/. The
 * file index is built once at startup: restart after rebuilding.
 */
export function configureIslands(app: INestApplication): void {
  if (!existsSync(directory)) {
    if (process.env['NODE_ENV'] === 'production')
      throw new Error(
        'dist/islands is missing; run the islands build before starting',
      );
    return;
  }
  app.use(viteStaticMiddleware({ root: directory, prefix: '/islands/' }));
}
