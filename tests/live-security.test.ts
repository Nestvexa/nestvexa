import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';

const resources: { root: string; module: TestingModule; engine: HbsEngine }[] =
  [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.module.close();
    await resource.engine.dispose();
    await rm(resource.root, { recursive: true, force: true });
  }
});

describe('Live initial mount resource limits', () => {
  it('rejects HTML above the update response budget without allocating a state token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestvexa-mount-limit-'));
    await writeFile(join(root, 'large.hbs'), 'x'.repeat(1_048_577));
    const engine = new HbsEngine({ root, maxTemplateBytes: 2_097_152 });
    await engine.initialize();
    @LiveComponent({ name: 'large', view: 'large' })
    class LargeComponent {
      @State() count = 0;
    }
    const module = await Test.createTestingModule({
      imports: [
        LiveModule.register({
          components: [LargeComponent],
          renderer: engine,
          origin: 'http://localhost',
          resolveIdentity: () => ({
            binding: 'host-session-identity',
            csrfToken: 'host-csrf-token-0123456789abcdef0123456789',
          }),
          authorize: () => true,
        }),
      ],
    }).compile();
    resources.push({ root, module, engine });
    const runtime = module.get(LiveRuntime);
    let rejected: unknown;
    try {
      await runtime.mount(LargeComponent, {});
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(HttpException);
    if (!(rejected instanceof HttpException))
      throw new Error('Expected mount resource rejection');
    expect(rejected.getStatus()).toBe(413);
    expect(runtime.store.size).toBe(0);
  });
});
