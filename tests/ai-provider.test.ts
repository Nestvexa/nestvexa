import { describe, expect, it } from 'vitest';
import { AiError, TestProvider } from '../packages/ai/dist/index.js';
import type { ChatEvent, ChatMessage } from '../packages/ai/dist/index.js';

async function events(
  provider: TestProvider,
  messages: readonly ChatMessage[],
  signal = new AbortController().signal,
): Promise<ChatEvent[]> {
  const result: ChatEvent[] = [];
  for await (const event of provider.stream(messages, { signal }))
    result.push(event);
  return result;
}
const rules = [
  {
    match: 'archive',
    reply: 'I can archive that product for you.',
    toolCall: { name: 'archiveProduct', arguments: { id: 'p1' } },
    afterTool: 'The product is archived.',
  },
  { match: /^hello\b/gi, reply: 'Hello from the scripted provider.' },
];

describe('TestProvider', () => {
  it('is explicitly labeled as a deterministic test provider, not a model', () => {
    const provider = new TestProvider({ rules: [] });
    expect(provider.kind).toBe('test');
    expect(provider.id).toBe('nestvexa-test-provider');
    expect(provider.label).toBe(
      'Deterministic test provider — not an AI model',
    );
    expect(Object.isFrozen(provider)).toBe(true);
  });

  it('replays identical chunked events for identical input', async () => {
    const provider = new TestProvider({
      rules,
      chunkDelayMs: 0,
      wordsPerChunk: 2,
    });
    const input: ChatMessage[] = [{ role: 'user', content: 'Hello there' }];
    const first = await events(provider, input);
    const second = await events(provider, input);
    expect(first).toEqual(second);
    expect(first).toEqual([
      { type: 'text', text: 'Hello from ' },
      { type: 'text', text: 'the scripted ' },
      { type: 'text', text: 'provider.' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('uses stateless regular expressions even when given global flags', async () => {
    const provider = new TestProvider({ rules, chunkDelayMs: 0 });
    for (let index = 0; index < 3; index += 1) {
      const result = await events(provider, [
        { role: 'user', content: 'hello again' },
      ]);
      expect(result.at(0)).toEqual({ type: 'text', text: 'Hello from ' });
    }
  });

  it('emits a tool call then done(tool-call), and the afterTool reply after a tool result', async () => {
    const provider = new TestProvider({ rules, chunkDelayMs: 0 });
    const request = await events(provider, [
      { role: 'user', content: 'Please ARCHIVE product p1' },
    ]);
    expect(request.slice(-2)).toEqual([
      {
        type: 'tool-call',
        id: 'test-call-1',
        name: 'archiveProduct',
        arguments: { id: 'p1' },
      },
      { type: 'done', reason: 'tool-call' },
    ]);
    const follow = await events(provider, [
      { role: 'user', content: 'Please archive product p1' },
      { role: 'assistant', content: 'I can archive that product for you.' },
      { role: 'tool', content: 'Archived p1', name: 'archiveProduct' },
    ]);
    expect(follow.map((event) => event.type)).not.toContain('tool-call');
    expect(
      follow
        .filter((event) => event.type === 'text')
        .map((event) => (event.type === 'text' ? event.text : ''))
        .join(''),
    ).toBe('The product is archived.');
  });

  it('falls back to a fixed reply for unknown prompts', async () => {
    const provider = new TestProvider({
      rules,
      chunkDelayMs: 0,
      fallback: 'No script.',
    });
    expect(
      await events(provider, [{ role: 'user', content: 'weather?' }]),
    ).toEqual([
      { type: 'text', text: 'No script.' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('stops promptly when aborted during a delay', async () => {
    const provider = new TestProvider({
      rules: [{ match: 'long', reply: 'one two three four five six seven' }],
      chunkDelayMs: 400,
      wordsPerChunk: 1,
    });
    const controller = new AbortController();
    const started = Date.now();
    const received: ChatEvent[] = [];
    setTimeout(() => controller.abort(), 30);
    await expect(
      (async () => {
        for await (const event of provider.stream(
          [{ role: 'user', content: 'long' }],
          { signal: controller.signal },
        ))
          received.push(event);
      })(),
    ).rejects.toBeInstanceOf(AiError);
    expect(received).toEqual([]);
    expect(Date.now() - started).toBeLessThan(300);
  });

  it.each([
    [{ rules: 'nope' }],
    [{ rules: [], chunkDelayMs: -1 }],
    [{ rules: [], wordsPerChunk: 0 }],
    [{ rules: [{ match: 1, reply: 'x' }] }],
    [{ rules: [{ match: 'x', reply: 1 }] }],
    [
      {
        rules: [
          {
            match: 'x',
            reply: 'y',
            toolCall: { name: 't', arguments: () => 1 },
          },
        ],
      },
    ],
    [
      {
        rules: [
          {
            match: 'x',
            reply: 'y',
            toolCall: { name: 't', arguments: JSON.parse('{"__proto__":1}') },
          },
        ],
      },
    ],
  ])('rejects invalid configuration %#', (options) => {
    expect(
      () =>
        new TestProvider(
          options as unknown as ConstructorParameters<typeof TestProvider>[0],
        ),
    ).toThrow(AiError);
  });
});
