# AI assistant panel with human-approved tool calls

`@nestvexa/ai` is an optional package for streaming chat in a Live component. It
provides the conversation state, a provider-neutral adapter interface, the
human approval workflow for tool calls, cancellation, timeouts and audit events.
The browser transport is the existing
[authorized text stream](./text-streams.md) (`nv:stream`), so no new endpoint
type, protocol or client bundle growth is involved.

Nothing here calls a real model. The package ships a deterministic
`TestProvider` that replays scripted text for tests and demonstrations; it is
labeled `kind: 'test'` and `Deterministic test provider — not an AI model`, and
any UI using it must show that label. Connecting a real provider is your code
(see [below](#connecting-a-real-provider)).

## 1. Register the assistant

```ts
import {
  AiModule,
  MemoryAuditSink,
  TestProvider,
  defineTool,
} from '@nestvexa/ai';

export const archiveProduct = defineTool<{ id: string }>({
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
  execute: ({ id }, { identity }) => {
    products.archive(identity, id);
    return `Archived ${id}`;
  },
});

AiModule.forRoot({
  provider: new TestProvider({
    rules: [
      {
        match: 'archive',
        reply: 'I can archive product p1 once you approve.',
        toolCall: { name: 'archiveProduct', arguments: { id: 'p1' } },
        afterTool: 'Product p1 is archived.',
      },
    ],
  }),
  tools: [archiveProduct],
  audit: new MemoryAuditSink(), // replace with a durable sink
});
```

`identity` everywhere is the host's identity binding — use the same value your
Live `resolveIdentity` returns as `binding`.

## 2. The Live component

```ts
@LiveComponent({ name: 'assistant-panel', view: 'assistant-panel' })
export class AssistantPanel {
  constructor(
    @Inject(AiAssistant) private readonly ai: AiAssistant,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @Locked() @State() conversationId = '';
  /** The call the person saw; approval never trusts a browser-supplied id. */
  @Locked() @State() shownCallId = '';
  @State({
    writable: true,
    validate: (v) => typeof v === 'string' && v.length <= 4000,
  })
  prompt = '';

  mount(): void {
    this.conversationId = this.ai.open(binding(this.request));
  }
  @Computed() get chat() {
    return this.ai.view(binding(this.request), this.conversationId);
  }
  @Action() ask(): void {
    this.ai.ask(binding(this.request), this.conversationId, this.prompt);
    this.prompt = '';
  }
  /** Called by the browser glue after each stream settles. */
  @Action() async collect(): Promise<void> {
    // A stopped stream may still be closing on the server; wait (bounded).
    await this.ai.settled(binding(this.request), this.conversationId);
    this.shownCallId =
      this.ai.view(binding(this.request), this.conversationId).pending
        ?.callId ?? '';
  }
  @Action() async approve(): Promise<void> {
    await this.ai.approve(
      binding(this.request),
      this.conversationId,
      this.shownCallId,
    );
    this.shownCallId = '';
  }
  @Action() reject(): void {
    this.ai.reject(
      binding(this.request),
      this.conversationId,
      this.shownCallId,
    );
    this.shownCallId = '';
  }
}
```

Authorize `$mount`, `ask`, `collect`, `approve`, `reject` and `$stream:assistant`
for this component in your host policy (optionally behind a feature flag with
`liveFlagPolicy` from `@nestvexa/flags`). `AiError` codes map naturally to
validation messages: `PROMPT` (empty/too long), `BUSY` (a turn is in progress),
`APPROVAL` (stale or invalid decision).

## 3. The stream route

An ordinary guarded Nest POST route, exactly like any other text stream:

```ts
@Post('assistant-stream')
@HttpCode(200)
async stream(@Req() request: SessionRequest, @Res({ passthrough: true }) response: object) {
  const input = parseTextStreamRequest(request.body);
  const authorization = await this.live.authorizeStream(request, AssistantPanel, 'assistant', {
    snapshot: input.snapshot,
    revision: input.revision,
  });
  return createTextStreamResponse({
    request,
    response,
    authorization,
    produce: ({ signal, state }) =>
      this.assistant.stream(binding(request), String(state['conversationId']), {
        signal,
        approvalNotice: (summary) => `\n${t('assistant:approvalNeeded', { summary })}`,
      }),
  });
}
```

Register the endpoint in the browser stream map
(`browser: { streams: { assistant: { endpoint: '/assistant-stream' } } }`).
The conversation id comes from the authorized snapshot state, and the assistant
additionally checks that the conversation belongs to the identity.

## 4. Template and browser glue

```hbs
<section
  data-nv-ai
  aria-labelledby='assistant-title'
  {{#if (eq chat.status 'ready')}}data-nv-ai-turn='ready'{{/if}}
  data-nv-ai-turn-id='{{conversationId}}:{{chat.turn}}'
  data-nv-ai-label-streaming='Generating…'
  data-nv-ai-label-done='Answer complete'
  data-nv-ai-label-cancelled='Stopped. Partial answer kept.'
  data-nv-ai-label-failed='The answer stopped. Ask again.'
>
  <h2 id='assistant-title'>Assistant</h2>
  <p class='badge'>{{chat.provider.label}}</p>
  <ol aria-label='Conversation'>
    {{#each chat.messages}}
      <li data-role='{{role}}'>{{text}}{{#if incomplete}} (incomplete){{/if}}</li>
    {{/each}}
  </ol>
  <output data-nv-ai-stream nv:stream='assistant' aria-live='off'></output>
  <p data-nv-ai-status role='status'></p>
  <button type='button' data-nv-ai-cancel disabled>Stop</button>
  {{#if chat.pending}}
    <div role='group' aria-labelledby='approval-title'>
      <h3 id='approval-title'>Approval required</h3>
      <p>{{chat.pending.summary}}</p>
      <button type='button' nv:click='approve'>Approve</button>
      <button type='button' nv:click='reject'>Reject</button>
    </div>
  {{/if}}
  <form nv:submit='ask'>
    <label for='prompt'>Ask</label>
    <textarea id='prompt' nv:model='prompt' maxlength='4000'></textarea>
    <button>Send</button>
  </form>
</section>
```

(`eq` stands for any trusted comparison helper you register; computing a boolean
such as `@Computed() get ready()` works equally well.) Every value is
interpolated with escaping `{{ }}`; the stream target writes a text node. In a
host module script:

```ts
import { app } from '/_nestvexa/boot.js';
import { connectAssistant } from '/vendor/ai/browser.js'; // serve @nestvexa/ai/browser
for (const panel of document.querySelectorAll('[data-nv-ai]'))
  connectAssistant(panel.closest('[data-nv-component]') ?? panel, app.client);
```

The glue starts each new ready turn once, toggles `aria-busy` and the Stop
button, writes the translated status labels into the `role="status"` element,
and calls `collect` exactly once when the stream settles. It never retries. The
[package README](../../packages/ai/README.md#browser-api-nestvexaaibrowser) lists
the full markup contract.

## Approval flow

1. `ask` stores the prompt; the conversation is `ready` and `turn` increments.
2. The browser streams the turn. A tool call is parsed, authorized for the
   identity and recorded as the single pending call (random 128-bit id, expiry);
   the approval notice is streamed; nothing executes.
3. `collect` re-renders: the panel shows the summary with Approve/Reject.
4. `approve` consumes the pending call before doing anything else (replay and
   double-submit execute at most once), re-runs `authorize`, executes with a
   timeout and stores the output. The conversation becomes `ready` again and the
   glue streams the follow-up answer.
5. `reject`, expiry, cancellation of the turn, or logout (`clear(identity)`) drop
   the call; the tool never runs.

## Cancellation and timeouts

Stop calls `client.cancelStream(target)`. The fetch aborts, the Live transport
aborts the producer's `signal`, the assistant aborts the provider and stops
pulling it immediately, and the partial answer is stored with
`incomplete: true` and outcome `cancelled`. The whole turn is limited by
`timeoutMs` (default 20 s, at most 28 s so it ends before the 30 s transport
cap); a timeout stores the partial text with outcome `timeout`. The transport
then reports a generic `STREAM_FAILED` record — never provider error text.
Browser cancellation cannot undo work a provider already did.

## Audit events

`turn.started|completed|cancelled|timeout|failed`,
`tool.requested|approved|rejected|executed|failed|denied` and
`approval.invalid`, each with an ISO timestamp, a pseudonymous `subject`
(sha256 prefix of the identity), conversation and call ids, tool name, provider
id and a short code. Prompts, answers and tool outputs are never included.
Implement `AiAuditSink` to persist them; sink failures are swallowed so they
cannot change outcomes.

## Threat model

- **Prompt injection** can make a model request any registered tool with any
  arguments. Therefore every tool call requires a person's approval, arguments
  pass `parse`, and `authorize` runs at request and approval time with the
  server identity. Register only tools you would expose as authenticated actions.
- **Forged approvals**: ids are bound to identity + conversation, compared in
  constant time, single-use and expiring; failures look identical.
- **XSS**: everything is text. Do not render model output as HTML or Markdown
  without a server-side allowlist sanitizer.
- **Secrets**: providers run only on the server; views, streams and audit records
  contain no provider configuration or errors.
- **Resource use**: prompt length, messages, conversations, identities, turn
  time, tool time, text size and the transport's own quotas are bounded.

## Connecting a real provider

Implement `ChatProvider` (`kind: 'model'`) in your application: map
`ChatMessage[]` and `ToolSpec[]` to your provider's request, pass the `signal`
to `fetch`, translate streamed deltas to `{ type: 'text' }`, tool requests to
`{ type: 'tool-call' }`, and finish with `{ type: 'done' }`. Keep the API key in
server configuration. The package README contains an illustrative, untested
skeleton. Nestvexa does not test or endorse any provider.

## Honest limits

- One pending call per conversation; a second call in the same turn fails it.
- Conversations live in process memory; restarts lose them and multiple
  instances need sticky sessions or a shared store implementation (not shipped).
- Streams are not resumable and the wire carries only text, so tool status is
  rendered after `collect`, not as structured stream events.
- Only plain-text rendering is provided.

Verification: [provider](../../tests/ai-provider.test.ts),
[approval and forgery](../../tests/ai-approval.test.ts),
[real Nest streaming](../../tests/ai-stream.test.ts) and
[browser glue in Chromium](../../tests/ai-browser.test.ts).
