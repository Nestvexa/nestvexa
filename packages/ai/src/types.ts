/** JSON values accepted in tool arguments and parameter schemas. */
export type AiJson =
  | null
  | boolean
  | number
  | string
  | readonly AiJson[]
  | { readonly [key: string]: AiJson };

/** A provider-neutral chat message. Content is always plain text. */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
}

/** Tool description offered to a provider. Parameters are an opaque JSON schema. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters?: AiJson;
}

/** Streamed provider event. Providers end every turn with `done`. */
export type ChatEvent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly id: string;
      readonly name: string;
      readonly arguments: AiJson;
    }
  | {
      readonly type: 'done';
      readonly reason?: 'stop' | 'tool-call' | 'length';
    };

export interface ChatStreamOptions {
  readonly signal: AbortSignal;
  readonly tools?: readonly ToolSpec[];
}

/**
 * Provider adapter. `kind: 'test'` marks deterministic fakes; adapters for real
 * models use `kind: 'model'` and keep credentials on the server.
 */
export interface ChatProvider {
  readonly id: string;
  readonly kind: 'test' | 'model';
  readonly label: string;
  stream(
    messages: readonly ChatMessage[],
    options: ChatStreamOptions,
  ): AsyncIterable<ChatEvent>;
}

export interface AiToolContext {
  readonly identity: string;
  readonly signal: AbortSignal;
}

/**
 * A server action the model may request. Every call requires an explicit human
 * approval; `authorize` runs when the model requests the call and again when a
 * person approves it.
 */
export interface AiTool<Args> {
  readonly name: string;
  readonly description: string;
  readonly parameters?: AiJson;
  /** Validate untrusted model-produced arguments; throw to reject them. */
  parse(input: unknown): Args;
  /** Plain-text description shown to the approving person. */
  summarize(args: Args): string;
  authorize(identity: string, args: Args): boolean | Promise<boolean>;
  execute(args: Args, context: AiToolContext): string | Promise<string>;
}

export type AiAuditType =
  | 'turn.started'
  | 'turn.completed'
  | 'turn.cancelled'
  | 'turn.timeout'
  | 'turn.failed'
  | 'tool.requested'
  | 'tool.approved'
  | 'tool.rejected'
  | 'tool.executed'
  | 'tool.failed'
  | 'tool.denied'
  | 'approval.invalid';

/** Audit record. Never contains prompt/response text or the raw identity. */
export interface AiAuditEvent {
  readonly type: AiAuditType;
  readonly at: string;
  /** First 16 hex characters of sha256(identity). */
  readonly subject: string;
  readonly conversation: string;
  readonly callId?: string;
  readonly tool?: string;
  readonly provider: string;
  /** A short machine code, never user or model text. */
  readonly detail?: string;
}

export interface AiAuditSink {
  record(event: AiAuditEvent): void | Promise<void>;
}

export type AiToolStatus = 'executed' | 'failed' | 'denied' | 'rejected';

export interface AiMessageView {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly incomplete: boolean;
  readonly tool?: string;
  readonly toolStatus?: AiToolStatus;
}

export interface AiPendingView {
  readonly callId: string;
  readonly tool: string;
  readonly summary: string;
  readonly expiresAt: string;
}

export type AiStatus =
  'idle' | 'ready' | 'streaming' | 'awaiting-approval' | 'executing' | 'failed';

export type AiOutcome =
  | 'completed'
  | 'cancelled'
  | 'timeout'
  | 'failed'
  | 'approved'
  | 'rejected'
  | 'denied'
  | 'expired'
  | 'tool-failed';

/** JSON-safe projection suitable for a Live `@Computed` value. */
export interface AiConversationView {
  readonly id: string;
  readonly status: AiStatus;
  /** Increments whenever a new turn becomes ready to stream. */
  readonly turn: number;
  readonly messages: readonly AiMessageView[];
  readonly pending: AiPendingView | null;
  readonly provider: {
    readonly id: string;
    readonly kind: 'test' | 'model';
    readonly label: string;
  };
  readonly lastOutcome: AiOutcome | null;
}

export interface AiAssistantOptions {
  readonly provider: ChatProvider;
  readonly tools?: readonly AiTool<unknown>[];
  readonly audit?: AiAuditSink;
  readonly system?: string;
  /** Whole-turn limit in milliseconds; default 20000, at most 28000. */
  readonly timeoutMs?: number;
  /** Pending approval lifetime; default 300000. */
  readonly approvalTtlMs?: number;
  /** Tool execution limit; default 10000. */
  readonly toolTimeoutMs?: number;
  readonly maxPromptLength?: number;
  readonly maxMessages?: number;
  readonly maxConversationsPerIdentity?: number;
  readonly maxIdentities?: number;
  readonly now?: () => number;
}

export interface AiStreamOptions {
  readonly signal: AbortSignal;
  /** Plain text appended to the stream when a call awaits approval. */
  readonly approvalNotice?: (summary: string) => string;
}

export interface AiApprovalResult {
  readonly status: 'executed' | 'failed' | 'denied';
  readonly output?: string;
}
