# @nestvexa/ai

Optional, provider-neutral streaming chat for Nestvexa Live applications, with
server-enforced human approval for tool calls, cancellation, timeouts and audit
events. It reuses the existing authorized Live text-stream route. It is **not**
part of the default `nestvexa` install, and it ships **no model provider, no API
key and no network client**. The bundled `TestProvider` is a deterministic,
scripted test double; it is not an AI model and its replies are not generated.

Alpha software; consult the root release blockers before production use.

## Install

The package is not published yet. Build local tarballs with
`pnpm build && pnpm test:pack` and install the packed `.tgz` file. Future
registry syntax:

```sh
npm install @nestvexa/ai
pnpm add @nestvexa/ai
yarn add @nestvexa/ai
```

Peers: `@nestjs/common` 12, `reflect-metadata` 0.2, `rxjs` 7.8. Node 22.13+ or
24, ESM (the `default` export condition lets CommonJS hosts load it through
`require(esm)`). No runtime dependencies. The `./browser` entry has no peers
and imports nothing. The stream route uses `createTextStreamResponse` from
`@nestvexa/live` (part of the `nestvexa` umbrella), which this package does not
depend on.

## Architecture role

```
Live component (assistant panel) ── ask/approve/reject/collect ──▶ AiAssistant
        │  nv:stream="assistant"                                       ▲
        ▼                                                              │
host POST route ─ live.authorizeStream ─ createTextStreamResponse ─ stream()
                                                                       │
                                                         ChatProvider (yours)
```

- `AiAssistant` holds conversations, the single pending tool call and limits, keyed
  by the host identity binding (for example the Live `binding`).
- Text reaches the browser only through `createTextStreamResponse`
  (`@nestvexa/live`), so origin, CSRF, identity, snapshot revision, quotas and
  per-chunk revalidation are the Live transport's. The wire carries text only.
- Tool calls never execute during a stream. They become a pending approval that
  the Live component renders; a person approves or rejects it through ordinary
  authorized Live actions, and the server re-checks everything at that point.

## Minimal usage

```ts
import { AiAssistant, AiModule, TestProvider, defineTool } from '@nestvexa/ai';

const archive = defineTool<{ id: string }>({
  name: 'archiveProduct',
  description: 'Archive one product by id',
  parse(input) {
    const id: unknown =
      input && typeof input === 'object' ? Reflect.get(input, 'id') : undefined;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id))
      throw new Error('Invalid product id');
    return { id };
  },
  summarize: ({ id }) => `Archive product ${id}`,
  authorize: (identity, { id }) => products.canArchive(identity, id),
  execute: async ({ id }, { identity, signal }) => {
    await products.archive(identity, id, { signal });
    return `Archived ${id}`;
  },
});

@Module({
  imports: [
    AiModule.forRoot({
      // Deterministic test double — replace with your own ChatProvider.
      provider: new TestProvider({
        rules: [
          {
            match: 'archive',
            reply: 'I can archive that product.',
            toolCall: { name: 'archiveProduct', arguments: { id: 'p1' } },
            afterTool: 'The product has been archived.',
          },
        ],
      }),
      tools: [archive],
    }),
  ],
})
class AssistantModule {}
```

The stream route (an ordinary guarded Nest controller):

```ts
@Post('assistant-stream')
@HttpCode(200)
async stream(@Req() request: SessionRequest, @Res({ passthrough: true }) response: object) {
  const input = parseTextStreamRequest(request.body);
  const authorization = await this.live.authorizeStream(request, AssistantPanel, 'assistant', {
    snapshot: input.snapshot,
    revision: input.revision,
  });
  const identity = bindingOf(request); // the same binding resolveIdentity returns
  return createTextStreamResponse({
    request,
    response,
    authorization,
    produce: ({ signal, state }) =>
      this.assistant.stream(identity, String(state['conversationId']), { signal }),
  });
}
```

The [AI guide](../../docs/guides/ai.md) walks through the Live component, the markup contract and the
browser glue end to end.

## Public API (`@nestvexa/ai`)

| Export                                                                                                                      | Purpose                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ChatProvider`                                                                                                              | Adapter interface: `id`, `kind: 'test' \| 'model'`, `label`, `stream(messages, { signal, tools })`.  |
| `ChatEvent`                                                                                                                 | `{ type: 'text', text }`, `{ type: 'tool-call', id, name, arguments }`, `{ type: 'done', reason? }`. |
| `ChatMessage`, `ToolSpec`, `ChatStreamOptions`, `AiJson`                                                                    | Provider-neutral message, tool description and JSON types.                                           |
| `TestProvider`, `TestRule`, `TestProviderOptions`                                                                           | Deterministic scripted provider (`kind: 'test'`, id `nestvexa-test-provider`).                       |
| `AiTool<Args>`, `AiToolContext`, `defineTool`                                                                               | Tool contract: `parse`, `summarize`, `authorize`, `execute`.                                         |
| `AiAssistant`                                                                                                               | `open`, `ask`, `stream`, `approve`, `reject`, `view`, `has`, `clear`.                                |
| `AiAssistantOptions`, `AiStreamOptions`, `AiApprovalResult`                                                                 | Options and results.                                                                                 |
| `AiConversationView`, `AiMessageView`, `AiPendingView`, `AiStatus`, `AiOutcome`, `AiToolStatus`                             | JSON-safe frozen projection for templates and Live `@Computed` values.                               |
| `AiAuditSink`, `AiAuditEvent`, `AiAuditType`, `MemoryAuditSink`, `auditSubject`                                             | Audit interface, bounded in-memory sink, identity pseudonym (sha256 prefix).                         |
| `AiError`, `AiErrorCode`                                                                                                    | Code-only errors: `CONVERSATION`, `PROMPT`, `BUSY`, `APPROVAL`, `TOOL`, `CONFIG`.                    |
| `AiModule.forRoot(options)`, `AiModule.forRootAsync({ imports, inject, useFactory })`, `AI_OPTIONS`, `AiModuleAsyncOptions` | Nest provider/export of one `AiAssistant`.                                                           |

### `AiAssistant`

- `open(identity)` → a random 128-bit conversation id bound to `identity`.
- `ask(identity, id, prompt)` — trims, strips control characters (except tab and
  newline), enforces `maxPromptLength`; requires status `idle` or `failed`; the
  status becomes `ready` and `turn` increments.
- `stream(identity, id, { signal, approvalNotice? })` → `AsyncIterable<string>`.
  Requires `ready`. Text chunks are forwarded (split to ≤ 2 KiB). On a tool call
  the tool must exist, `parse` must accept the arguments and `authorize` must
  allow it; only one call may be requested per turn. A pending call is created and
  `approvalNotice(summary)` (default `\n[Approval required: …]`) is streamed. On
  completion the answer is stored. The signal and the turn timeout abort the
  provider and stop pulling it immediately; partial text is stored with
  `incomplete: true` and outcome `cancelled` or `timeout`, any requested call is
  dropped, and the iterator ends with an error so the transport reports a
  generic failure. Provider errors become outcome `failed`; their text is never
  stored, streamed or audited.
- `approve(identity, id, callId)` → `{ status: 'executed' | 'failed' | 'denied', output? }`.
  The call id must match the single pending call of that identity's conversation
  (constant-time comparison) and must not be expired. It is consumed before any
  await, so replays and concurrent approvals execute at most once. `authorize` runs
  again, then `execute` runs with `toolTimeoutMs` and an `AbortSignal`. On success
  a tool message is stored and the conversation is `ready` for the model's
  follow-up stream. Every invalid attempt throws `AiError('APPROVAL')` with the
  same message and records `approval.invalid`; it never reveals whether a call
  exists for someone else.
- `reject(identity, id, callId)` — same checks; the tool never runs.
- `view(identity, id)` — frozen JSON: `id`, `status`
  (`idle | ready | streaming | awaiting-approval | executing | failed`), `turn`,
  `messages` (`role`, plain `text`, `incomplete`, `tool?`, `toolStatus?`),
  `pending` (`callId`, `tool`, `summary`, `expiresAt`), `provider`, `lastOutcome`.
  Unknown or foreign conversations throw `AiError('CONVERSATION')`.
- `settled(identity, id, timeoutMs = 2000)` — resolves with the status once a
  streaming turn has recorded its outcome (or after the bounded timeout). Await
  it in the collect action: after a browser Stop, the collect request can arrive
  before the server has observed the disconnect.
- `has(identity, id)` — ownership check without throwing.
- `clear(identity)` — logout: drops every conversation and pending call.

### Defaults

| Option                         | Default                                   | Bounds                                   |
| ------------------------------ | ----------------------------------------- | ---------------------------------------- |
| `timeoutMs` (whole turn)       | 20000                                     | 1–28000 (below the 30 s text-stream cap) |
| `approvalTtlMs`                | 300000                                    | 1–86400000                               |
| `toolTimeoutMs`                | 10000                                     | 1–60000                                  |
| `maxPromptLength`              | 4000                                      | 1–100000                                 |
| `maxMessages` (sliding window) | 40                                        | 2–1000                                   |
| `maxConversationsPerIdentity`  | 8 (oldest evicted)                        | 1–1000                                   |
| `maxIdentities`                | 10000 (oldest evicted)                    | 1–10000000                               |
| assistant text per turn        | 16000 characters (then `failed`/`LENGTH`) | fixed                                    |
| tool output stored             | 4000 characters                           | fixed                                    |

### `TestProvider`

`new TestProvider({ rules, fallback?, chunkDelayMs = 15, wordsPerChunk = 2 })`.
Each rule `{ match, reply, toolCall?, afterTool? }` is matched against the latest
user message (case-insensitive substring, or a `RegExp` copied without `g`/`y`).
It streams `reply` in fixed word chunks with AbortSignal-aware delays, then emits
the `toolCall` and `done('tool-call')`, or `done('stop')`. When the last message is
a tool result it streams `afterTool`. Labeled `kind: 'test'`,
`label: 'Deterministic test provider — not an AI model'`. Show this label in any
UI that uses it.

## Browser API (`@nestvexa/ai/browser`)

`connectAssistant(root, client, { collectAction = 'collect' })` → `{ dispose() }`.
`client` is the Live client (structural `startStream`, `cancelStream`, `call`).

Markup contract (rendered by your Live template):

| Selector / attribute                                  | Meaning                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `[data-nv-ai]`                                        | Panel inside a Live component root (`[data-nv-component]`).          |
| `data-nv-ai-turn="ready"` + `data-nv-ai-turn-id`      | A turn awaits streaming; the id is opaque, `[A-Za-z0-9_:.-]{1,128}`. |
| `[data-nv-ai-stream]` with `nv:stream="assistant"`    | Text-only stream target.                                             |
| `[data-nv-ai-cancel]`                                 | Stop button; enabled only while streaming.                           |
| `[data-nv-ai-status]` (`role="status"`)               | Receives the translated label for the current phase.                 |
| `data-nv-ai-label-streaming\|done\|cancelled\|failed` | Server-rendered (translated) status labels on the panel.             |

On connect and on every `nestvexa:updated` event it starts each new ready turn
exactly once (never retrying), sets `aria-busy`, enables stop, and after the
stream settles (completed, stopped or failed) calls the collect action exactly
once. Stop calls `client.cancelStream(target)`. `dispose()` removes listeners and
cancels in-flight streams. The module is CSP-safe (no eval, no inline code, no
HTML parsing) and safe to import in Node.

## Security

- **Human approval is mandatory and server-enforced.** There is no auto-approve
  option. Approval is bound to identity, conversation and one random call id,
  expires, and cannot be replayed. `authorize` runs at request and approval time.
  Treat model output as untrusted: prompt injection can request any registered
  tool, so tools must validate (`parse`) and authorize every argument as if it came
  from an attacker.
- **Rendering is plain text.** Messages are stored and streamed as text; render
  with escaped `{{text}}` or text nodes (the Live stream target already uses a
  text node). There is no Markdown/HTML rendering; if you add it, sanitize on the
  server with an allowlist sanitizer.
- **Secrets stay on the server.** Providers run only in Nest; nothing in the view,
  stream or audit contains provider configuration or provider error text.
- **Audit** records types, timestamps, a sha256-based subject, conversation and
  call ids, tool names and short codes — never prompt or response text. Audit sink
  failures are ignored so they cannot change outcomes; make durable sinks reliable.
- **Logout** must call `clear(identity)`.

## Connecting a real provider

Implement `ChatProvider` in your application with `kind: 'model'`. The following is
an illustrative skeleton for a generic streaming HTTP API; it is not shipped, not
tested here, and you must adapt it to your provider's documented protocol:

```ts
class HttpChatProvider implements ChatProvider {
  readonly id = 'my-provider';
  readonly kind = 'model';
  readonly label = 'My provider';
  async *stream(
    messages: readonly ChatMessage[],
    { signal, tools }: ChatStreamOptions,
  ) {
    const response = await fetch(process.env.CHAT_API_URL!, {
      method: 'POST',
      signal, // cancellation and timeouts propagate to the network request
      headers: {
        authorization: `Bearer ${process.env.CHAT_API_KEY}`, // server-side only
        'content-type': 'application/json',
      },
      body: JSON.stringify({ messages, tools, stream: true }),
    });
    if (!response.ok || !response.body) throw new Error('provider unavailable');
    for await (const event of parseYourProviderStream(response.body)) {
      if (event.kind === 'delta') yield { type: 'text', text: event.text };
      if (event.kind === 'tool')
        yield {
          type: 'tool-call',
          id: event.id,
          name: event.name,
          arguments: event.args,
        };
    }
    yield { type: 'done', reason: 'stop' };
  }
}
```

(The non-null assertion and `parseYourProviderStream` are placeholders for your
own configuration validation and parser.)

## Compatibility and links

Node 22.13+/24, NestJS 12, ESM. Works with the default HBS + Live setup; the browser
entry works with any Live client exposing the three methods. See the
[AI guide](../../docs/guides/ai.md), [text streams](../../docs/guides/text-streams.md),
[`nv:stream`](../../docs/reference/nv-stream.md) and the
[`examples/admin-i18n`](../../examples/admin-i18n/README.md) assistant
(approval-required tool with the test provider).

## Status and limits

Status: **Shipped (alpha)**. Provider-neutral streaming, server-enforced tool
approval, cancellation, timeouts, audit events and the browser glue are
implemented and tested with the deterministic `TestProvider`.

- No model provider ships; real providers are host-supplied `ChatProvider`
  implementations and are not tested here.
- Conversations and approvals live in process memory: a restart loses them, and
  multiple instances need sticky sessions or a shared store (not provided).
- One pending call per conversation; a second tool call in a turn fails the turn.
- Streams are not resumable; a stopped turn keeps its partial text marked
  incomplete and the user asks again.
- Browser cancellation cannot undo server work already done.
- The text-stream transport has its own limits (30 s, 1 MiB, 4096 records).

## Testing

```sh
pnpm --filter @nestvexa/ai test
```

Runs `tests/ai-*.test.ts` (provider, approval forgery/replay/concurrency/expiry,
real Nest Express streaming through `createTextStreamResponse` with
cancellation and timeout, and the browser glue in real Chromium under a strict
CSP; no network or keys); build first with `pnpm --filter @nestvexa/ai... build`
because the tests import `dist`. The `examples/admin-i18n` browser spec
`tests/browser/admin-i18n.spec.ts` exercises the assistant through the root
Playwright config.

## Maintainers

Maintained by the Nestvexa project (GitHub organization `Nestvexa`). Review ownership per path is in [CODEOWNERS](../../.github/CODEOWNERS) and roles and the decision process are in [GOVERNANCE.md](../../GOVERNANCE.md). No individual maintainers are named until the owner appoints them. Changes are recorded in the [changelog](../../CHANGELOG.md).
