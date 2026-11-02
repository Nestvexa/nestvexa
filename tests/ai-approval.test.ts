import { describe, expect, it } from 'vitest';
import {
  AiAssistant,
  AiError,
  MemoryAuditSink,
  TestProvider,
  auditSubject,
  defineTool,
} from '../packages/ai/dist/index.js';
import type {
  AiAssistantOptions,
  ChatEvent,
  ChatProvider,
} from '../packages/ai/dist/index.js';

const alice = 'tenant-a/session/alice-0001';
const bob = 'tenant-a/session/bob-000002';
const secretPrompt = 'please archive p1 SECRET-PROMPT-TEXT';

function fixture(overrides: Partial<AiAssistantOptions> = {}) {
  const state = {
    executions: 0,
    allowAtRequest: true,
    allowAtApproval: true,
    authorizeCalls: 0,
    clock: 1_700_000_000_000,
    archived: new Set<string>(),
  };
  const archive = defineTool<{ id: string }>({
    name: 'archiveProduct',
    description: 'Archive one product by id',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    parse(input) {
      const id: unknown =
        input && typeof input === 'object' && !Array.isArray(input)
          ? Reflect.get(input, 'id')
          : undefined;
      if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id))
        throw new Error('bad id');
      return { id };
    },
    summarize: (args) => `Archive product ${args.id}`,
    authorize: () => {
      state.authorizeCalls += 1;
      return state.authorizeCalls === 1
        ? state.allowAtRequest
        : state.allowAtApproval;
    },
    execute: (args) => {
      state.executions += 1;
      state.archived.add(args.id);
      return `Archived ${args.id}`;
    },
  });
  const audit = new MemoryAuditSink();
  const assistant = new AiAssistant({
    provider: new TestProvider({
      chunkDelayMs: 0,
      rules: [
        {
          match: 'archive p1',
          reply: 'I can archive p1.',
          toolCall: { name: 'archiveProduct', arguments: { id: 'p1' } },
          afterTool: 'Done: p1 is archived.',
        },
        {
          match: 'archive bad',
          reply: 'Trying.',
          toolCall: { name: 'archiveProduct', arguments: { id: '../etc' } },
        },
        {
          match: 'unknown tool',
          reply: 'Trying.',
          toolCall: { name: 'dropDatabase', arguments: {} },
        },
        { match: 'hello', reply: 'Hello there.' },
      ],
    }),
    tools: [archive],
    audit,
    now: () => state.clock,
    ...overrides,
  });
  return { assistant, audit, state };
}
async function drain(iterable: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const chunk of iterable) text += chunk;
  return text;
}
function signal(): AbortSignal {
  return new AbortController().signal;
}
async function pendingCall(
  assistant: AiAssistant,
  identity = alice,
): Promise<{ conversation: string; callId: string }> {
  const conversation = assistant.open(identity);
  assistant.ask(identity, conversation, secretPrompt);
  await drain(assistant.stream(identity, conversation, { signal: signal() }));
  const callId = assistant.view(identity, conversation).pending?.callId;
  if (!callId) throw new Error('Expected a pending call');
  return { conversation, callId };
}
function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof AiError ? error.code : 'OTHER';
  }
  return undefined;
}

describe('AiAssistant approval workflow', () => {
  it('streams, waits for approval, executes once and streams the follow-up', async () => {
    const { assistant, state } = fixture();
    const conversation = assistant.open(alice);
    expect(conversation).toMatch(/^[A-Za-z0-9_-]{22}$/);
    assistant.ask(alice, conversation, secretPrompt);
    expect(assistant.view(alice, conversation).status).toBe('ready');
    const text = await drain(
      assistant.stream(alice, conversation, {
        signal: signal(),
        approvalNotice: (summary) => ` (needs approval: ${summary})`,
      }),
    );
    expect(text).toBe('I can archive p1. (needs approval: Archive product p1)');
    const view = assistant.view(alice, conversation);
    expect(view.status).toBe('awaiting-approval');
    expect(view.pending).toMatchObject({
      tool: 'archiveProduct',
      summary: 'Archive product p1',
    });
    expect(view.pending?.callId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(state.executions).toBe(0);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(view.provider.kind).toBe('test');

    const result = await assistant.approve(
      alice,
      conversation,
      view.pending?.callId ?? '',
    );
    expect(result).toEqual({ status: 'executed', output: 'Archived p1' });
    expect(state.executions).toBe(1);
    const after = assistant.view(alice, conversation);
    expect(after.status).toBe('ready');
    expect(after.turn).toBe(2);
    expect(after.messages.at(-1)).toMatchObject({
      role: 'tool',
      text: 'Archived p1',
      toolStatus: 'executed',
      tool: 'archiveProduct',
    });
    expect(
      await drain(assistant.stream(alice, conversation, { signal: signal() })),
    ).toBe('Done: p1 is archived.');
    expect(assistant.view(alice, conversation).status).toBe('idle');
  });

  it('rejects forged approvals without revealing other identities’ calls', async () => {
    const { assistant, audit, state } = fixture();
    const { conversation, callId } = await pendingCall(assistant);
    const other = assistant.open(alice);
    const bobs = await pendingCall(assistant, bob);
    const attempts: [string, string, unknown][] = [
      [bob, conversation, callId],
      [alice, other, callId],
      [alice, conversation, 'A'.repeat(22)],
      [alice, conversation, bobs.callId],
      [alice, bobs.conversation, bobs.callId],
      [alice, conversation, 42],
      [alice, '__proto__', callId],
    ];
    for (const [identity, id, call] of attempts)
      await expect(
        assistant.approve(identity, id, call as string),
      ).rejects.toMatchObject({ code: 'APPROVAL' });
    expect(state.executions).toBe(0);
    expect(
      audit.events.filter((event) => event.type === 'approval.invalid'),
    ).toHaveLength(attempts.length);
    // The legitimate call is still pending after the forgeries.
    expect(assistant.view(alice, conversation).pending?.callId).toBe(callId);
  });

  it('cannot replay an approval or approve after rejection', async () => {
    const { assistant, state } = fixture();
    const first = await pendingCall(assistant);
    await assistant.approve(alice, first.conversation, first.callId);
    await expect(
      assistant.approve(alice, first.conversation, first.callId),
    ).rejects.toMatchObject({ code: 'APPROVAL' });
    const second = await pendingCall(assistant);
    assistant.reject(alice, second.conversation, second.callId);
    expect(assistant.view(alice, second.conversation)).toMatchObject({
      status: 'idle',
      lastOutcome: 'rejected',
      pending: null,
    });
    await expect(
      assistant.approve(alice, second.conversation, second.callId),
    ).rejects.toMatchObject({ code: 'APPROVAL' });
    expect(
      codeOf(() => assistant.reject(alice, second.conversation, second.callId)),
    ).toBe('APPROVAL');
    expect(state.executions).toBe(1);
  });

  it('executes a concurrently double-approved call exactly once', async () => {
    const { assistant, state } = fixture();
    const { conversation, callId } = await pendingCall(assistant);
    const results = await Promise.allSettled([
      assistant.approve(alice, conversation, callId),
      assistant.approve(alice, conversation, callId),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(state.executions).toBe(1);
  });

  it('expires pending approvals', async () => {
    const { assistant, state, audit } = fixture({ approvalTtlMs: 1000 });
    const { conversation, callId } = await pendingCall(assistant);
    state.clock += 1001;
    await expect(
      assistant.approve(alice, conversation, callId),
    ).rejects.toMatchObject({ code: 'APPROVAL' });
    expect(assistant.view(alice, conversation)).toMatchObject({
      status: 'idle',
      lastOutcome: 'expired',
      pending: null,
    });
    expect(
      audit.events.some(
        (event) => event.type === 'tool.rejected' && event.detail === 'EXPIRED',
      ),
    ).toBe(true);
    expect(state.executions).toBe(0);
  });

  it('never creates a pending call the host does not authorize', async () => {
    const { assistant, state, audit } = fixture();
    state.allowAtRequest = false;
    const conversation = assistant.open(alice);
    assistant.ask(alice, conversation, secretPrompt);
    await drain(assistant.stream(alice, conversation, { signal: signal() }));
    const view = assistant.view(alice, conversation);
    expect(view.pending).toBeNull();
    expect(view.status).toBe('idle');
    expect(view.messages.at(-1)).toMatchObject({ toolStatus: 'denied' });
    expect(audit.events.map((event) => event.type)).toContain('tool.denied');
    expect(state.executions).toBe(0);
  });

  it('re-authorizes at approval time', async () => {
    const { assistant, state } = fixture();
    const { conversation, callId } = await pendingCall(assistant);
    state.allowAtApproval = false;
    expect(await assistant.approve(alice, conversation, callId)).toEqual({
      status: 'denied',
    });
    expect(state.executions).toBe(0);
    expect(assistant.view(alice, conversation).lastOutcome).toBe('denied');
  });

  it.each(['archive bad', 'unknown tool'])(
    'fails the turn for invalid model tool calls (%s)',
    async (prompt) => {
      const { assistant, audit } = fixture();
      const conversation = assistant.open(alice);
      assistant.ask(alice, conversation, prompt);
      await expect(
        drain(assistant.stream(alice, conversation, { signal: signal() })),
      ).rejects.toBeInstanceOf(AiError);
      expect(assistant.view(alice, conversation)).toMatchObject({
        status: 'failed',
        pending: null,
        lastOutcome: 'failed',
      });
      expect(audit.events.at(-1)?.type).toBe('turn.failed');
      // A failed conversation accepts a fresh prompt.
      assistant.ask(alice, conversation, 'hello');
      expect(
        await drain(
          assistant.stream(alice, conversation, { signal: signal() }),
        ),
      ).toBe('Hello there.');
    },
  );

  it('allows only one pending call per turn', async () => {
    const provider: ChatProvider = {
      id: 'double',
      kind: 'test',
      label: 'test double',
      async *stream(): AsyncGenerator<ChatEvent> {
        yield {
          type: 'tool-call',
          id: 'a',
          name: 'archiveProduct',
          arguments: { id: 'p1' },
        };
        yield {
          type: 'tool-call',
          id: 'b',
          name: 'archiveProduct',
          arguments: { id: 'p2' },
        };
        yield { type: 'done', reason: 'tool-call' };
      },
    };
    const { assistant, audit } = fixture({ provider });
    const conversation = assistant.open(alice);
    assistant.ask(alice, conversation, 'two calls');
    await expect(
      drain(assistant.stream(alice, conversation, { signal: signal() })),
    ).rejects.toBeInstanceOf(AiError);
    expect(assistant.view(alice, conversation).pending).toBeNull();
    expect(audit.events.at(-1)).toMatchObject({
      type: 'turn.failed',
      detail: 'SECOND_TOOL_CALL',
    });
  });

  it('records audit events without prompt text or raw identities', async () => {
    const { assistant, audit } = fixture();
    const { conversation, callId } = await pendingCall(assistant);
    await assistant.approve(alice, conversation, callId);
    const serialized = JSON.stringify(audit.events);
    expect(serialized).not.toContain('SECRET-PROMPT-TEXT');
    expect(serialized).not.toContain(alice);
    expect(serialized).not.toContain('Archived p1');
    expect(audit.events.map((event) => event.type)).toEqual([
      'turn.started',
      'tool.requested',
      'turn.completed',
      'tool.approved',
      'tool.executed',
    ]);
    for (const event of audit.events) {
      expect(event.subject).toBe(auditSubject(alice));
      expect(event.subject).toMatch(/^[0-9a-f]{16}$/);
      expect(event.provider).toBe('nestvexa-test-provider');
      expect(Object.isFrozen(event)).toBe(true);
    }
  });

  it('clears all conversations and approvals on logout', async () => {
    const { assistant, state } = fixture();
    const { conversation, callId } = await pendingCall(assistant);
    assistant.clear(alice);
    expect(codeOf(() => assistant.view(alice, conversation))).toBe(
      'CONVERSATION',
    );
    await expect(
      assistant.approve(alice, conversation, callId),
    ).rejects.toMatchObject({ code: 'APPROVAL' });
    expect(state.executions).toBe(0);
  });

  it('enforces turn state and prompt validation', async () => {
    const { assistant } = fixture({ maxPromptLength: 20 });
    const conversation = assistant.open(alice);
    expect(codeOf(() => assistant.view(bob, conversation))).toBe(
      'CONVERSATION',
    );
    expect(codeOf(() => assistant.ask(alice, conversation, '   '))).toBe(
      'PROMPT',
    );
    expect(
      codeOf(() => assistant.ask(alice, conversation, 'x'.repeat(21))),
    ).toBe('PROMPT');
    await expect(
      drain(assistant.stream(alice, conversation, { signal: signal() })),
    ).rejects.toMatchObject({ code: 'BUSY' });
    assistant.ask(alice, conversation, 'hel\u0000lo\u0007\r\n');
    expect(assistant.view(alice, conversation).messages.at(-1)?.text).toBe(
      'hello',
    );
    expect(codeOf(() => assistant.ask(alice, conversation, 'again'))).toBe(
      'BUSY',
    );
    expect(codeOf(() => assistant.open(''))).toBe('CONVERSATION');
  });

  it('reports tool failures and timeouts without leaking errors', async () => {
    const tool = defineTool<null>({
      name: 'archiveProduct',
      description: 'never finishes',
      parse: () => null,
      summarize: () => 'Hang',
      authorize: () => true,
      execute: (_args, context) =>
        new Promise<string>((_resolve, reject) => {
          context.signal.addEventListener('abort', () =>
            reject(new Error('PRIVATE-TOOL-DETAIL')),
          );
        }),
    });
    const { assistant, audit } = fixture({ tools: [tool], toolTimeoutMs: 30 });
    const { conversation, callId } = await pendingCall(assistant);
    expect(await assistant.approve(alice, conversation, callId)).toEqual({
      status: 'failed',
    });
    expect(assistant.view(alice, conversation)).toMatchObject({
      status: 'idle',
      lastOutcome: 'tool-failed',
    });
    expect(audit.events.at(-1)).toMatchObject({
      type: 'tool.failed',
      detail: 'TOOL_TIMEOUT',
    });
    expect(JSON.stringify(audit.events)).not.toContain('PRIVATE');
  });

  it('never exposes provider error text', async () => {
    const provider: ChatProvider = {
      id: 'broken',
      kind: 'model',
      label: 'broken provider',
      stream(): AsyncIterable<ChatEvent> {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('provider-key-sk-PRIVATE')),
          }),
        };
      },
    };
    const { assistant, audit } = fixture({ provider });
    const conversation = assistant.open(alice);
    assistant.ask(alice, conversation, 'hello');
    const failure = await drain(
      assistant.stream(alice, conversation, { signal: signal() }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiError);
    expect(String((failure as Error).message)).not.toContain('PRIVATE');
    expect(JSON.stringify(assistant.view(alice, conversation))).not.toContain(
      'PRIVATE',
    );
    expect(audit.events.at(-1)).toMatchObject({
      type: 'turn.failed',
      detail: 'PROVIDER',
    });
  });

  it('drops a requested call when the turn is cancelled', async () => {
    const { assistant, state } = fixture();
    const conversation = assistant.open(alice);
    assistant.ask(alice, conversation, secretPrompt);
    const controller = new AbortController();
    const stream = assistant.stream(alice, conversation, {
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await iterator.return?.();
    const view = assistant.view(alice, conversation);
    expect(view).toMatchObject({
      status: 'idle',
      lastOutcome: 'cancelled',
      pending: null,
    });
    expect(view.messages.at(-1)).toMatchObject({
      role: 'assistant',
      incomplete: true,
    });
    expect(state.executions).toBe(0);
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 30_000 },
    { approvalTtlMs: -1 },
    { maxMessages: 1 },
    { provider: { id: 'x', kind: 'fake', label: 'x', stream: () => [] } },
  ])('rejects invalid configuration %j', (overrides) => {
    expect(() =>
      fixture(overrides as unknown as Partial<AiAssistantOptions>),
    ).toThrow(AiError);
  });

  it('rejects duplicate or unsafe tool names', () => {
    const base = {
      description: 'x',
      parse: () => null,
      summarize: () => 'x',
      authorize: () => true,
      execute: () => 'x',
    };
    expect(() =>
      fixture({
        tools: [
          { ...base, name: 'same' },
          { ...base, name: 'same' },
        ],
      }),
    ).toThrow(AiError);
    expect(() => fixture({ tools: [{ ...base, name: '__proto__' }] })).toThrow(
      AiError,
    );
  });
});

describe('settled()', () => {
  it('waits for a cancelled stream to record its outcome before collect reads it', async () => {
    const assistant = new AiAssistant({
      provider: new TestProvider({
        chunkDelayMs: 20,
        rules: [{ match: 'long', reply: 'one two three four five six seven' }],
      }),
    });
    const id = assistant.open(alice);
    expect(await assistant.settled(alice, id)).toBe('idle');
    assistant.ask(alice, id, 'long please');
    const abort = new AbortController();
    const turn = assistant.stream(alice, id, { signal: abort.signal });
    const iterator = turn[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    expect(assistant.view(alice, id).status).toBe('streaming');
    const waiting = assistant.settled(alice, id, 5_000);
    abort.abort();
    // Drain like the transport does; the stopped turn rejects.
    await iterator.next().catch(() => undefined);
    expect(await waiting).toBe('idle');
    const view = assistant.view(alice, id);
    expect(view.lastOutcome).toBe('cancelled');
    expect(view.messages.at(-1)?.incomplete).toBe(true);
    // Another identity cannot wait on (or probe) the conversation.
    await expect(assistant.settled(bob, id)).rejects.toBeInstanceOf(AiError);
  });
  it('resolves with the current status after a bounded timeout', async () => {
    const assistant = new AiAssistant({
      provider: new TestProvider({
        chunkDelayMs: 50,
        rules: [{ match: 'x', reply: 'a b c d e f g h' }],
      }),
    });
    const id = assistant.open(alice);
    assistant.ask(alice, id, 'x');
    const abort = new AbortController();
    const turn = assistant.stream(alice, id, { signal: abort.signal });
    const iterator = turn[Symbol.asyncIterator]();
    await iterator.next();
    expect(await assistant.settled(alice, id, 10)).toBe('streaming');
    abort.abort();
    await iterator.next().catch(() => undefined);
  });
});
