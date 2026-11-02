import 'reflect-metadata';
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
  createTextStreamResponse,
  parseTextStreamRequest,
} from '../packages/live/dist/index.js';
import {
  AiAssistant,
  MemoryAuditSink,
  TestProvider,
} from '../packages/ai/dist/index.js';

const csrf = 'ai-stream-fixture-csrf-0123456789abcdef012345';
const origin = 'http://localhost:3100';
interface HostRequest {
  readonly headers: Record<string, string | undefined>;
  readonly body: unknown;
}
function binding(request: object): string {
  const headers: unknown = Reflect.get(request, 'headers');
  const session: unknown =
    headers && typeof headers === 'object'
      ? Reflect.get(headers, 'x-session')
      : undefined;
  if (session !== 'alice' && session !== 'bob') throw new ForbiddenException();
  return `tenant/session-${session}`;
}
const audit = new MemoryAuditSink();
const reply =
  'Streaming answer with <script>alert(1)</script> literal text and many more words to stream slowly';
function assistantWith(timeoutMs: number, chunkDelayMs: number): AiAssistant {
  return new AiAssistant({
    provider: new TestProvider({
      rules: [{ match: 'go', reply }],
      chunkDelayMs,
      wordsPerChunk: 2,
    }),
    audit,
    timeoutMs,
  });
}
const host = { assistant: assistantWith(20_000, 0), conversation: '' };
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1)
    await delay(10);
  expect(check()).toBe(true);
}

describe('AiAssistant through an authorized Live text stream (Express)', () => {
  let app: INestApplication;
  let engine: HbsEngine;
  let directory: string;
  let base: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nestvexa-ai-stream-'));
    await writeFile(
      join(directory, 'assistant.hbs'),
      '<p>{{conversationId}}</p>',
    );
    engine = new HbsEngine({ root: directory });
    await engine.initialize();
    @LiveComponent({ name: 'assistant-panel', view: 'assistant' })
    class AssistantPanel {
      @State() conversationId = '';
      mount(): void {
        this.conversationId = host.conversation;
      }
    }
    @Controller()
    class HostController {
      constructor(@Inject(LiveRuntime) readonly runtime: LiveRuntime) {}
      @Get('mount') async mount(@Req() request: HostRequest) {
        return {
          html: (await this.runtime.mount(AssistantPanel, request)).value,
        };
      }
      @Post('assistant-stream')
      @HttpCode(200)
      async stream(
        @Req() request: HostRequest,
        @Res({ passthrough: true }) response: object,
      ) {
        const input = parseTextStreamRequest(request.body);
        const authorization = await this.runtime.authorizeStream(
          request,
          AssistantPanel,
          'assistant',
          { snapshot: input.snapshot, revision: input.revision },
        );
        const identity = binding(request);
        return createTextStreamResponse({
          request,
          response,
          authorization,
          produce: ({ signal, state }) =>
            host.assistant.stream(identity, String(state['conversationId']), {
              signal,
            }),
        });
      }
    }
    @Module({
      imports: [
        LiveModule.register({
          components: [AssistantPanel],
          renderer: engine,
          origin,
          maxRequestsPerMinute: 1000,
          resolveIdentity: (request) => ({
            binding: binding(request),
            csrfToken: csrf,
          }),
          authorize: (_identity, component, action) =>
            component === 'assistant-panel' &&
            ['$mount', '$stream:assistant'].includes(action),
        }),
      ],
      controllers: [HostController],
    })
    class HostModule {}
    const compiled = await Test.createTestingModule({
      imports: [HostModule],
    }).compile();
    app = compiled.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await engine?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function prepare(
    assistant: AiAssistant,
    session = 'alice',
  ): Promise<{ conversation: string; snapshot: string }> {
    host.assistant = assistant;
    host.conversation = assistant.open(`tenant/session-${session}`);
    assistant.ask(`tenant/session-${session}`, host.conversation, 'go');
    const response = await fetch(`${base}/mount`, {
      headers: { 'x-session': session, connection: 'close' },
    });
    const body = (await response.json()) as { html: string };
    const snapshot = /data-nv-snapshot="([^"]+)"/.exec(body.html)?.[1];
    if (!snapshot) throw new Error('Missing snapshot');
    return { conversation: host.conversation, snapshot };
  }
  function post(snapshot: string, signal?: AbortSignal, session = 'alice') {
    return fetch(`${base}/assistant-stream`, {
      method: 'POST',
      headers: {
        connection: 'close',
        'content-type': 'application/json',
        origin,
        'x-session': session,
        'x-nestvexa-csrf': csrf,
      },
      body: JSON.stringify({
        protocol: 'nestvexa-stream/1',
        requestId: 'ai-request',
        snapshot,
        revision: 0,
      }),
      ...(signal ? { signal } : {}),
    });
  }
  function records(
    text: string,
  ): { type: string; text?: string; code?: string }[] {
    return text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; text?: string });
  }

  it('streams provider text as literal NDJSON text records and stores the answer', async () => {
    const assistant = assistantWith(20_000, 0);
    const { conversation, snapshot } = await prepare(assistant);
    const response = await post(snapshot);
    expect(response.status).toBe(200);
    const lines = records(await response.text());
    expect(lines.at(-1)?.type).toBe('done');
    const text = lines
      .filter((line) => line.type === 'text')
      .map((line) => line.text)
      .join('');
    expect(text).toBe(reply);
    expect(JSON.stringify(lines)).toContain('<script>alert(1)</script>');
    const view = assistant.view('tenant/session-alice', conversation);
    expect(view.status).toBe('idle');
    expect(view.messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: reply,
      incomplete: false,
    });
  });
  it('records a cancelled, incomplete turn when the browser aborts mid-stream', async () => {
    const assistant = assistantWith(20_000, 60);
    const { conversation, snapshot } = await prepare(assistant);
    const controller = new AbortController();
    const response = await post(snapshot, controller.signal);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing body');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"type":"text"');
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await eventually(
      () =>
        assistant.view('tenant/session-alice', conversation).lastOutcome ===
        'cancelled',
    );
    const view = assistant.view('tenant/session-alice', conversation);
    expect(view.status).toBe('idle');
    expect(view.messages.at(-1)).toMatchObject({
      role: 'assistant',
      incomplete: true,
    });
    expect((view.messages.at(-1)?.text.length ?? 0) < reply.length).toBe(true);
    expect(audit.events.some((event) => event.type === 'turn.cancelled')).toBe(
      true,
    );
  });

  it('times out a slow provider and reports a generic stream failure', async () => {
    const assistant = assistantWith(150, 80);
    const { conversation, snapshot } = await prepare(assistant);
    const response = await post(snapshot);
    const lines = records(await response.text());
    expect(lines.at(-1)).toMatchObject({
      type: 'error',
      code: 'STREAM_FAILED',
    });
    const view = assistant.view('tenant/session-alice', conversation);
    expect(view.lastOutcome).toBe('timeout');
    expect(view.messages.at(-1)?.incomplete).toBe(true);
    expect(audit.events.some((event) => event.type === 'turn.timeout')).toBe(
      true,
    );
  });

  it('refuses a concurrent second stream of the same turn', async () => {
    const assistant = assistantWith(20_000, 40);
    const { conversation, snapshot } = await prepare(assistant);
    const first = post(snapshot);
    await eventually(
      () =>
        assistant.view('tenant/session-alice', conversation).status ===
        'streaming',
    );
    const second = records(await (await post(snapshot)).text());
    expect(second).toEqual([
      expect.objectContaining({ type: 'error', code: 'STREAM_FAILED' }),
    ]);
    const firstLines = records(await (await first).text());
    expect(firstLines.at(-1)?.type).toBe('done');
    expect(assistant.view('tenant/session-alice', conversation).status).toBe(
      'idle',
    );
  });

  it('rejects another identity replaying the snapshot', async () => {
    const assistant = assistantWith(20_000, 0);
    const { conversation, snapshot } = await prepare(assistant);
    const response = await post(snapshot, undefined, 'bob');
    // Snapshots are bound to the owner's binding: another identity cannot find it.
    expect([403, 410]).toContain(response.status);
    expect(assistant.view('tenant/session-alice', conversation).status).toBe(
      'ready',
    );
  });
});
