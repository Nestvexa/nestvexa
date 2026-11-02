import { AiError } from './errors.js';
import type {
  AiJson,
  ChatEvent,
  ChatMessage,
  ChatProvider,
  ChatStreamOptions,
} from './types.js';

/** One scripted exchange. `match` is tested against the latest user message. */
export interface TestRule {
  readonly match: string | RegExp;
  readonly reply: string;
  readonly toolCall?: { readonly name: string; readonly arguments: AiJson };
  /** Reply streamed after an approved tool call returns its result. */
  readonly afterTool?: string;
}

export interface TestProviderOptions {
  readonly rules: readonly TestRule[];
  readonly fallback?: string;
  /** Delay between chunks in milliseconds; default 15. */
  readonly chunkDelayMs?: number;
  /** Words per text chunk; default 2. */
  readonly wordsPerChunk?: number;
}

interface CompiledRule {
  readonly test: (text: string) => boolean;
  readonly reply: string;
  readonly toolCall?: { readonly name: string; readonly arguments: AiJson };
  readonly afterTool?: string;
}

function json(value: unknown, depth = 0): AiJson {
  if (depth > 16) throw new AiError('CONFIG', 'Tool arguments are too deep');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value))
    return Object.freeze(value.map((item: unknown) => json(item, depth + 1)));
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new AiError('CONFIG', 'Tool arguments must be plain JSON');
    const output: Record<string, AiJson> = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== 'string' ||
        ['__proto__', 'prototype', 'constructor'].includes(key) ||
        !descriptor ||
        !('value' in descriptor)
      )
        throw new AiError('CONFIG', 'Tool arguments must be plain JSON');
      output[key] = json(descriptor.value, depth + 1);
    }
    return Object.freeze(output);
  }
  throw new AiError('CONFIG', 'Tool arguments must be plain JSON');
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AiError('BUSY', 'Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    function abort(): void {
      clearTimeout(timer);
      reject(new AiError('BUSY', 'Aborted'));
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Deterministic scripted provider for tests and demonstrations.
 * It is NOT an AI model: it replays fixed text chosen by simple matching.
 */
export class TestProvider implements ChatProvider {
  readonly id = 'nestvexa-test-provider';
  readonly kind = 'test' as const;
  readonly label = 'Deterministic test provider — not an AI model';
  readonly #rules: readonly CompiledRule[];
  readonly #fallback: string;
  readonly #delay: number;
  readonly #words: number;

  constructor(options: TestProviderOptions) {
    if (!options || !Array.isArray(options.rules) || options.rules.length > 256)
      throw new AiError('CONFIG', 'TestProvider requires a rule list');
    this.#delay = options.chunkDelayMs ?? 15;
    this.#words = options.wordsPerChunk ?? 2;
    if (
      !Number.isSafeInteger(this.#delay) ||
      this.#delay < 0 ||
      this.#delay > 5000 ||
      !Number.isSafeInteger(this.#words) ||
      this.#words < 1 ||
      this.#words > 64
    )
      throw new AiError('CONFIG', 'Invalid TestProvider timing');
    this.#fallback =
      options.fallback ??
      'This deterministic test provider only knows its scripted prompts.';
    if (typeof this.#fallback !== 'string')
      throw new AiError('CONFIG', 'Invalid TestProvider fallback');
    this.#rules = Object.freeze(
      options.rules.map((rule): CompiledRule => {
        if (typeof rule.reply !== 'string')
          throw new AiError('CONFIG', 'Each rule needs a text reply');
        if (rule.afterTool !== undefined && typeof rule.afterTool !== 'string')
          throw new AiError('CONFIG', 'afterTool must be text');
        let test: (text: string) => boolean;
        if (typeof rule.match === 'string') {
          const needle = rule.match.toLowerCase();
          test = (text) => text.toLowerCase().includes(needle);
        } else if (rule.match instanceof RegExp) {
          // Stateless copy: global/sticky flags would make matching order-dependent.
          const pattern = new RegExp(
            rule.match.source,
            rule.match.flags.replace(/[gy]/g, ''),
          );
          test = (text) => pattern.test(text);
        } else throw new AiError('CONFIG', 'Rule match must be text or RegExp');
        let toolCall: CompiledRule['toolCall'];
        if (rule.toolCall !== undefined) {
          if (typeof rule.toolCall.name !== 'string')
            throw new AiError('CONFIG', 'Tool call needs a name');
          toolCall = Object.freeze({
            name: rule.toolCall.name,
            arguments: json(rule.toolCall.arguments),
          });
        }
        return Object.freeze({
          test,
          reply: rule.reply,
          ...(toolCall ? { toolCall } : {}),
          ...(rule.afterTool === undefined
            ? {}
            : { afterTool: rule.afterTool }),
        });
      }),
    );
    Object.freeze(this);
  }

  #chunks(text: string): string[] {
    const parts = text.match(/\S+\s*|\s+/g) ?? [];
    const chunks: string[] = [];
    for (let index = 0; index < parts.length; index += this.#words)
      chunks.push(parts.slice(index, index + this.#words).join(''));
    return chunks;
  }

  async *stream(
    messages: readonly ChatMessage[],
    options: ChatStreamOptions,
  ): AsyncGenerator<ChatEvent> {
    const signal = options.signal;
    const last = messages.at(-1);
    let user: ChatMessage | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === 'user') {
        user = message;
        break;
      }
    }
    const rule = user
      ? this.#rules.find((candidate) => candidate.test(user.content))
      : undefined;
    const afterTool = last?.role === 'tool';
    const text = afterTool
      ? (rule?.afterTool ?? this.#fallback)
      : (rule?.reply ?? this.#fallback);
    for (const chunk of this.#chunks(text)) {
      if (signal.aborted) return;
      if (this.#delay) await sleep(this.#delay, signal);
      yield { type: 'text', text: chunk };
    }
    if (signal.aborted) return;
    if (!afterTool && rule?.toolCall) {
      yield {
        type: 'tool-call',
        id: `test-call-${messages.length}`,
        name: rule.toolCall.name,
        arguments: rule.toolCall.arguments,
      };
      yield { type: 'done', reason: 'tool-call' };
      return;
    }
    yield { type: 'done', reason: 'stop' };
  }
}
