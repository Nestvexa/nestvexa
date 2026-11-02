import { randomBytes, timingSafeEqual } from 'node:crypto';
import { auditSubject } from './audit.js';
import { AiError } from './errors.js';
import type {
  AiApprovalResult,
  AiAssistantOptions,
  AiAuditEvent,
  AiAuditSink,
  AiAuditType,
  AiConversationView,
  AiOutcome,
  AiStatus,
  AiStreamOptions,
  AiTool,
  AiToolStatus,
  ChatEvent,
  ChatMessage,
  ChatProvider,
  ToolSpec,
} from './types.js';

interface StoredMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly incomplete: boolean;
  readonly tool?: string;
  readonly toolCallId?: string;
  readonly toolStatus?: AiToolStatus;
}
interface Pending {
  readonly callId: string;
  readonly tool: AiTool<unknown>;
  readonly args: unknown;
  readonly summary: string;
  readonly expiresAt: number;
}
interface Conversation {
  readonly id: string;
  status: AiStatus;
  turn: number;
  messages: StoredMessage[];
  pending: Pending | null;
  lastOutcome: AiOutcome | null;
  sequence: number;
}

const idPattern = /^[A-Za-z0-9_-]{22}$/;
const toolName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const maxAssistantText = 16_000;
const maxToolOutput = 4_000;
const maxChunk = 2_048;

function randomId(): string {
  return randomBytes(16).toString('base64url');
}
function sameId(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function integer(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
    throw new AiError(
      'CONFIG',
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  return result;
}
function identityOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512)
    throw new AiError('CONVERSATION', 'Invalid identity');
  return value;
}
/** Remove C0 controls except tab/newline, and DEL; normalise line endings. */
function cleanText(value: string): string {
  let output = '';
  for (const character of value.replace(/\r\n?/g, '\n')) {
    const code = character.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f)
      continue;
    output += character;
  }
  return output;
}
function swallow(result: unknown): void {
  if (result instanceof Promise) result.catch(() => undefined);
}
class Stop extends Error {
  constructor(readonly reason: 'cancelled' | 'timeout') {
    super(reason);
  }
}
class Failure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Server-side conversation state, streaming and human approval for tool calls.
 * State is process-local memory bounded by the configured limits.
 */
export class AiAssistant {
  readonly #provider: ChatProvider;
  readonly #tools = new Map<string, AiTool<unknown>>();
  readonly #toolSpecs: readonly ToolSpec[];
  readonly #audit: AiAuditSink | undefined;
  readonly #system: string | undefined;
  readonly #timeout: number;
  readonly #approvalTtl: number;
  readonly #toolTimeout: number;
  readonly #maxPrompt: number;
  readonly #maxMessages: number;
  readonly #maxConversations: number;
  readonly #maxIdentities: number;
  readonly #now: () => number;
  readonly #identities = new Map<string, Map<string, Conversation>>();
  readonly #settled = new WeakMap<Conversation, Set<() => void>>();

  constructor(options: AiAssistantOptions) {
    if (!options || typeof options !== 'object')
      throw new AiError('CONFIG', 'Assistant options are required');
    const provider = options.provider;
    if (
      !provider ||
      typeof provider.stream !== 'function' ||
      typeof provider.id !== 'string' ||
      typeof provider.label !== 'string' ||
      (provider.kind !== 'test' && provider.kind !== 'model')
    )
      throw new AiError('CONFIG', 'A ChatProvider is required');
    this.#provider = provider;
    for (const tool of options.tools ?? []) {
      if (
        !tool ||
        typeof tool.name !== 'string' ||
        !toolName.test(tool.name) ||
        ['constructor', 'prototype', '__proto__'].includes(tool.name) ||
        typeof tool.parse !== 'function' ||
        typeof tool.summarize !== 'function' ||
        typeof tool.authorize !== 'function' ||
        typeof tool.execute !== 'function' ||
        typeof tool.description !== 'string'
      )
        throw new AiError('CONFIG', 'Invalid tool definition');
      if (this.#tools.has(tool.name))
        throw new AiError('CONFIG', `Duplicate tool: ${tool.name}`);
      this.#tools.set(tool.name, tool);
    }
    this.#toolSpecs = Object.freeze(
      [...this.#tools.values()].map((tool) =>
        Object.freeze({
          name: tool.name,
          description: tool.description,
          ...(tool.parameters === undefined
            ? {}
            : { parameters: tool.parameters }),
        }),
      ),
    );
    if (
      options.audit !== undefined &&
      typeof options.audit?.record !== 'function'
    )
      throw new AiError('CONFIG', 'Audit sink must implement record()');
    this.#audit = options.audit;
    if (options.system !== undefined && typeof options.system !== 'string')
      throw new AiError('CONFIG', 'System prompt must be text');
    this.#system = options.system;
    this.#timeout = integer(options.timeoutMs, 20_000, 1, 28_000, 'timeoutMs');
    this.#approvalTtl = integer(
      options.approvalTtlMs,
      300_000,
      1,
      86_400_000,
      'approvalTtlMs',
    );
    this.#toolTimeout = integer(
      options.toolTimeoutMs,
      10_000,
      1,
      60_000,
      'toolTimeoutMs',
    );
    this.#maxPrompt = integer(
      options.maxPromptLength,
      4_000,
      1,
      100_000,
      'maxPromptLength',
    );
    this.#maxMessages = integer(
      options.maxMessages,
      40,
      2,
      1_000,
      'maxMessages',
    );
    this.#maxConversations = integer(
      options.maxConversationsPerIdentity,
      8,
      1,
      1_000,
      'maxConversationsPerIdentity',
    );
    this.#maxIdentities = integer(
      options.maxIdentities,
      10_000,
      1,
      10_000_000,
      'maxIdentities',
    );
    if (options.now !== undefined && typeof options.now !== 'function')
      throw new AiError('CONFIG', 'now must be a function');
    this.#now = options.now ?? Date.now;
  }

  #record(
    type: AiAuditType,
    identity: string,
    conversation: string,
    extra: Partial<Pick<AiAuditEvent, 'callId' | 'tool' | 'detail'>> = {},
  ): void {
    if (!this.#audit) return;
    const event: AiAuditEvent = Object.freeze({
      type,
      at: new Date(this.#now()).toISOString(),
      subject: auditSubject(identity),
      conversation,
      provider: this.#provider.id,
      ...extra,
    });
    try {
      swallow(this.#audit.record(event));
    } catch {
      // Audit failures must not change the user-visible outcome.
    }
  }

  #find(identity: string, conversationId: unknown): Conversation | undefined {
    if (typeof conversationId !== 'string' || !idPattern.test(conversationId))
      return undefined;
    return this.#identities.get(identity)?.get(conversationId);
  }

  #get(identity: unknown, conversationId: unknown): Conversation {
    const owner = identityOf(identity);
    const conversation = this.#find(owner, conversationId);
    if (!conversation)
      throw new AiError('CONVERSATION', 'Unknown conversation');
    this.#expire(owner, conversation);
    return conversation;
  }

  #expire(identity: string, conversation: Conversation): void {
    const pending = conversation.pending;
    if (!pending || this.#now() <= pending.expiresAt) return;
    conversation.pending = null;
    conversation.status = 'idle';
    conversation.lastOutcome = 'expired';
    this.#push(conversation, {
      role: 'tool',
      text: 'Approval expired.',
      incomplete: false,
      tool: pending.tool.name,
      toolCallId: pending.callId,
      toolStatus: 'rejected',
    });
    this.#record('tool.rejected', identity, conversation.id, {
      callId: pending.callId,
      tool: pending.tool.name,
      detail: 'EXPIRED',
    });
  }

  #push(conversation: Conversation, message: Omit<StoredMessage, 'id'>): void {
    conversation.sequence += 1;
    conversation.messages.push(
      Object.freeze({ id: `m${conversation.sequence}`, ...message }),
    );
    while (conversation.messages.length > this.#maxMessages)
      conversation.messages.shift();
  }

  /** Start a conversation bound to this identity. */
  open(identity: string): string {
    const owner = identityOf(identity);
    let conversations = this.#identities.get(owner);
    if (!conversations) {
      if (this.#identities.size >= this.#maxIdentities) {
        const oldest = this.#identities.keys().next().value;
        if (oldest !== undefined) this.#identities.delete(oldest);
      }
      conversations = new Map();
      this.#identities.set(owner, conversations);
    }
    if (conversations.size >= this.#maxConversations) {
      const oldest = conversations.keys().next().value;
      if (oldest !== undefined) conversations.delete(oldest);
    }
    const id = randomId();
    conversations.set(id, {
      id,
      status: 'idle',
      turn: 0,
      messages: [],
      pending: null,
      lastOutcome: null,
      sequence: 0,
    });
    return id;
  }

  /** Record a user prompt; the conversation becomes ready to stream. */
  ask(identity: string, conversationId: string, prompt: string): void {
    const conversation = this.#get(identity, conversationId);
    if (conversation.status !== 'idle' && conversation.status !== 'failed')
      throw new AiError('BUSY', 'The conversation is busy');
    if (typeof prompt !== 'string')
      throw new AiError('PROMPT', 'Prompt must be text');
    const text = cleanText(prompt).trim();
    if (!text || text.length > this.#maxPrompt)
      throw new AiError('PROMPT', 'Prompt is empty or too long');
    this.#push(conversation, { role: 'user', text, incomplete: false });
    conversation.status = 'ready';
    conversation.turn += 1;
    conversation.lastOutcome = null;
  }

  #messages(conversation: Conversation): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (this.#system) messages.push({ role: 'system', content: this.#system });
    for (const message of conversation.messages)
      messages.push(
        message.role === 'tool'
          ? {
              role: 'tool',
              content: message.text,
              ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
              ...(message.tool ? { name: message.tool } : {}),
            }
          : { role: message.role, content: message.text },
      );
    return messages;
  }

  /**
   * Stream one ready turn as plain text chunks for `createTextStreamResponse`.
   * Cancellation (the signal) and the turn timeout stop the provider promptly.
   */
  stream(
    identity: string,
    conversationId: string,
    options: AiStreamOptions,
  ): AsyncIterable<string> {
    const signal = options?.signal;
    if (!(signal instanceof AbortSignal))
      throw new AiError('CONFIG', 'An AbortSignal is required');
    const notice =
      options.approvalNotice ??
      ((summary: string) => `\n[Approval required: ${summary}]`);
    return this.#run(identity, conversationId, signal, notice);
  }

  async *#run(
    identity: string,
    conversationId: string,
    external: AbortSignal,
    notice: (summary: string) => string,
  ): AsyncGenerator<string> {
    const owner = identityOf(identity);
    const conversation = this.#get(owner, conversationId);
    if (conversation.status !== 'ready')
      throw new AiError('BUSY', 'No turn is ready to stream');
    conversation.status = 'streaming';
    this.#record('turn.started', owner, conversation.id);
    const controller = new AbortController();
    let stopReason: 'cancelled' | 'timeout' | undefined;
    const stop = (reason: 'cancelled' | 'timeout') => {
      if (stopReason) return;
      stopReason = reason;
      controller.abort(new Stop(reason));
    };
    const onAbort = () => stop('cancelled');
    if (external.aborted) stop('cancelled');
    else external.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout'), this.#timeout);
    timer.unref?.();
    const stopped = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(new Stop(stopReason ?? 'cancelled'));
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener('abort', fail, { once: true });
    });
    stopped.catch(() => undefined);

    let text = '';
    let pending: Pending | null = null;
    // Tool notes are stored after the assistant text they belong to.
    const notes: Omit<StoredMessage, 'id'>[] = [];
    let outcome: 'completed' | 'cancelled' | 'timeout' | 'failed' | undefined;
    let failureCode = 'PROVIDER';
    let iterator: AsyncIterator<ChatEvent> | undefined;
    try {
      const iterable = this.#provider.stream(this.#messages(conversation), {
        signal: controller.signal,
        tools: this.#toolSpecs,
      });
      iterator = iterable[Symbol.asyncIterator]();
      for (;;) {
        const next = Promise.resolve(iterator.next());
        next.catch(() => undefined);
        const item = await Promise.race([next, stopped]);
        if (item.done) break;
        const event = item.value;
        if (event.type === 'done') break;
        if (event.type === 'text') {
          if (typeof event.text !== 'string') throw new Failure('PROVIDER');
          const chunk = cleanText(event.text);
          if (!chunk) continue;
          if (text.length + chunk.length > maxAssistantText) {
            text += chunk.slice(0, maxAssistantText - text.length);
            throw new Failure('LENGTH');
          }
          text += chunk;
          for (let index = 0; index < chunk.length; index += maxChunk)
            yield chunk.slice(index, index + maxChunk);
          if (controller.signal.aborted)
            throw new Stop(stopReason ?? 'cancelled');
          continue;
        }
        if (event.type === 'tool-call') {
          if (pending) throw new Failure('SECOND_TOOL_CALL');
          const tool =
            typeof event.name === 'string'
              ? this.#tools.get(event.name)
              : undefined;
          if (!tool) throw new Failure('UNKNOWN_TOOL');
          let args: unknown;
          let summary: string;
          try {
            args = tool.parse(event.arguments);
            summary = cleanText(String(tool.summarize(args))).slice(0, 500);
          } catch {
            throw new Failure('TOOL_ARGUMENTS');
          }
          let allowed: boolean;
          try {
            allowed = (await tool.authorize(owner, args)) === true;
          } catch {
            allowed = false;
          }
          if (!allowed) {
            this.#record('tool.denied', owner, conversation.id, {
              tool: tool.name,
              detail: 'REQUEST',
            });
            notes.push({
              role: 'tool',
              text: 'Tool call denied by server policy.',
              incomplete: false,
              tool: tool.name,
              toolStatus: 'denied',
            });
            continue;
          }
          pending = Object.freeze({
            callId: randomId(),
            tool,
            args,
            summary,
            expiresAt: this.#now() + this.#approvalTtl,
          });
          this.#record('tool.requested', owner, conversation.id, {
            callId: pending.callId,
            tool: tool.name,
          });
          const message = cleanText(String(notice(summary)));
          if (message) yield message.slice(0, maxChunk);
          continue;
        }
        throw new Failure('PROVIDER');
      }
      if (controller.signal.aborted) throw new Stop(stopReason ?? 'cancelled');
      outcome = 'completed';
    } catch (error) {
      if (error instanceof Stop || stopReason) {
        outcome = stopReason ?? 'cancelled';
      } else {
        outcome = 'failed';
        failureCode = error instanceof Failure ? error.code : 'PROVIDER';
      }
    } finally {
      clearTimeout(timer);
      external.removeEventListener('abort', onAbort);
      if (!controller.signal.aborted) controller.abort(new Stop('cancelled'));
      if (iterator?.return) {
        try {
          swallow(iterator.return());
        } catch {
          // A provider's cleanup failure is not visible to the user.
        }
      }
      // A consumer that stops at a yield point never reaches the catch block.
      const final = outcome ?? stopReason ?? 'cancelled';
      this.#finish(owner, conversation, final, text, pending, failureCode);
      for (const note of notes) this.#push(conversation, note);
    }
    if (outcome !== 'completed') throw new AiError('BUSY', 'Turn stopped');
  }

  #finish(
    identity: string,
    conversation: Conversation,
    outcome: 'completed' | 'cancelled' | 'timeout' | 'failed',
    text: string,
    pending: Pending | null,
    failureCode: string,
  ): void {
    try {
      this.#settle(identity, conversation, outcome, text, pending, failureCode);
    } finally {
      const waiters = this.#settled.get(conversation);
      this.#settled.delete(conversation);
      for (const wake of waiters ?? []) wake();
    }
  }

  #settle(
    identity: string,
    conversation: Conversation,
    outcome: 'completed' | 'cancelled' | 'timeout' | 'failed',
    text: string,
    pending: Pending | null,
    failureCode: string,
  ): void {
    if (text)
      this.#push(conversation, {
        role: 'assistant',
        text,
        incomplete: outcome !== 'completed',
      });
    conversation.lastOutcome = outcome;
    if (outcome === 'completed') {
      conversation.pending = pending;
      conversation.status = pending ? 'awaiting-approval' : 'idle';
      this.#record('turn.completed', identity, conversation.id);
      return;
    }
    // A stopped or failed turn never leaves an approvable call behind.
    conversation.pending = null;
    conversation.status = outcome === 'failed' ? 'failed' : 'idle';
    this.#record(
      outcome === 'failed'
        ? 'turn.failed'
        : outcome === 'timeout'
          ? 'turn.timeout'
          : 'turn.cancelled',
      identity,
      conversation.id,
      outcome === 'failed' ? { detail: failureCode } : {},
    );
  }

  /** Validate a decision and consume the single pending call before acting. */
  #consume(
    identity: unknown,
    conversationId: unknown,
    callId: unknown,
  ): { owner: string; conversation: Conversation; pending: Pending } {
    const owner = identityOf(identity);
    const conversation = this.#find(owner, conversationId);
    if (conversation) this.#expire(owner, conversation);
    const pending = conversation?.pending;
    if (
      !conversation ||
      !pending ||
      conversation.status !== 'awaiting-approval' ||
      typeof callId !== 'string' ||
      !sameId(pending.callId, callId)
    ) {
      this.#record(
        'approval.invalid',
        owner,
        typeof conversationId === 'string' && idPattern.test(conversationId)
          ? conversationId
          : 'invalid',
      );
      throw new AiError('APPROVAL', 'No matching pending approval');
    }
    conversation.pending = null;
    return { owner, conversation, pending };
  }

  /**
   * Approve the pending call. Authorization is re-checked; the tool runs at most
   * once even under replay or concurrent approval.
   */
  async approve(
    identity: string,
    conversationId: string,
    callId: string,
  ): Promise<AiApprovalResult> {
    const { owner, conversation, pending } = this.#consume(
      identity,
      conversationId,
      callId,
    );
    const tool = pending.tool;
    conversation.status = 'executing';
    this.#record('tool.approved', owner, conversation.id, {
      callId: pending.callId,
      tool: tool.name,
    });
    let allowed: boolean;
    try {
      allowed = (await tool.authorize(owner, pending.args)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      this.#push(conversation, {
        role: 'tool',
        text: 'Tool call denied by server policy.',
        incomplete: false,
        tool: tool.name,
        toolCallId: pending.callId,
        toolStatus: 'denied',
      });
      conversation.status = 'idle';
      conversation.lastOutcome = 'denied';
      this.#record('tool.denied', owner, conversation.id, {
        callId: pending.callId,
        tool: tool.name,
        detail: 'APPROVAL',
      });
      return Object.freeze({ status: 'denied' });
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Failure('TOOL_TIMEOUT'));
          controller.abort();
        }, this.#toolTimeout);
      });
      timeout.catch(() => undefined);
      const result: unknown = await Promise.race([
        Promise.resolve(
          tool.execute(pending.args, {
            identity: owner,
            signal: controller.signal,
          }),
        ),
        timeout,
      ]);
      if (typeof result !== 'string') throw new Failure('TOOL_RESULT');
      const output = cleanText(result).slice(0, maxToolOutput);
      this.#push(conversation, {
        role: 'tool',
        text: output,
        incomplete: false,
        tool: tool.name,
        toolCallId: pending.callId,
        toolStatus: 'executed',
      });
      conversation.status = 'ready';
      conversation.turn += 1;
      conversation.lastOutcome = 'approved';
      this.#record('tool.executed', owner, conversation.id, {
        callId: pending.callId,
        tool: tool.name,
      });
      return Object.freeze({ status: 'executed', output });
    } catch (error) {
      this.#push(conversation, {
        role: 'tool',
        text: 'Tool failed.',
        incomplete: false,
        tool: tool.name,
        toolCallId: pending.callId,
        toolStatus: 'failed',
      });
      conversation.status = 'idle';
      conversation.lastOutcome = 'tool-failed';
      this.#record('tool.failed', owner, conversation.id, {
        callId: pending.callId,
        tool: tool.name,
        detail: error instanceof Failure ? error.code : 'TOOL_ERROR',
      });
      return Object.freeze({ status: 'failed' });
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  /** Reject the pending call; the tool never runs. */
  reject(identity: string, conversationId: string, callId: string): void {
    const { owner, conversation, pending } = this.#consume(
      identity,
      conversationId,
      callId,
    );
    this.#push(conversation, {
      role: 'tool',
      text: 'Rejected by the user.',
      incomplete: false,
      tool: pending.tool.name,
      toolCallId: pending.callId,
      toolStatus: 'rejected',
    });
    conversation.status = 'idle';
    conversation.lastOutcome = 'rejected';
    this.#record('tool.rejected', owner, conversation.id, {
      callId: pending.callId,
      tool: pending.tool.name,
      detail: 'USER',
    });
  }

  /** JSON-safe, frozen snapshot of a conversation owned by this identity. */
  view(identity: string, conversationId: string): AiConversationView {
    const conversation = this.#get(identity, conversationId);
    const pending = conversation.pending;
    return Object.freeze({
      id: conversation.id,
      status: conversation.status,
      turn: conversation.turn,
      messages: Object.freeze(
        conversation.messages.map((message) =>
          Object.freeze({
            id: message.id,
            role: message.role,
            text: message.text,
            incomplete: message.incomplete,
            ...(message.tool ? { tool: message.tool } : {}),
            ...(message.toolStatus ? { toolStatus: message.toolStatus } : {}),
          }),
        ),
      ),
      pending: pending
        ? Object.freeze({
            callId: pending.callId,
            tool: pending.tool.name,
            summary: pending.summary,
            expiresAt: new Date(pending.expiresAt).toISOString(),
          })
        : null,
      provider: Object.freeze({
        id: this.#provider.id,
        kind: this.#provider.kind,
        label: this.#provider.label,
      }),
      lastOutcome: conversation.lastOutcome,
    });
  }

  /**
   * Wait (bounded) until a streaming turn has recorded its outcome. A browser
   * that cancels a stream can call its collect action before the server has
   * observed the disconnect; awaiting this avoids reading a stale 'streaming'
   * view. Resolves with the current status; never throws on timeout.
   */
  async settled(
    identity: string,
    conversationId: string,
    timeoutMs = 2_000,
  ): Promise<AiStatus> {
    const conversation = this.#get(identity, conversationId);
    if (conversation.status !== 'streaming') return conversation.status;
    const limit = Math.min(Math.max(Math.trunc(timeoutMs) || 0, 0), 10_000);
    await new Promise<void>((resolve) => {
      let waiters = this.#settled.get(conversation);
      if (!waiters) {
        waiters = new Set();
        this.#settled.set(conversation, waiters);
      }
      const timer = setTimeout(done, limit);
      timer.unref();
      function done(): void {
        clearTimeout(timer);
        waiters?.delete(done);
        resolve();
      }
      waiters.add(done);
    });
    return conversation.status;
  }

  /** Whether this identity owns the conversation (for host routing decisions). */
  has(identity: string, conversationId: string): boolean {
    return this.#find(identityOf(identity), conversationId) !== undefined;
  }

  /** Logout: drop every conversation and pending approval for the identity. */
  clear(identity: string): void {
    this.#identities.delete(identityOf(identity));
  }
}
