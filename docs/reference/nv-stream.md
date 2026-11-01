# nv:stream

Render an explicitly requested, authorized read-only NDJSON stream as text.
This directive never parses HTML, runs an action expression, or chooses a URL.
It is independent of mutation requests and does not retry automatically.

```hbs
<output id='report' nv:stream='summary' aria-label='Report summary'></output>
```

Configure a trusted endpoint map on `createLiveClient`:

```ts
const client = createLiveClient({
  streams: { summary: { endpoint: '/reports/summary' } },
});
client.mount();
const target = document.getElementById('report');
if (!target) throw new Error('Missing report target');
await client.startStream(target);
```

The element lookup above must succeed in application code. The real starter
checks the target before calling the API. A trusted event handler starts the
read; `nv:stream` itself does not send requests during discovery. Use
`client.cancelStream(target)` to cancel it. No JavaScript expression in a Live
directive starts a stream.

The umbrella's automatic browser mode accepts the same static map at
`browser.streams` in the Live registration. Paths include the application's
public prefix. The host still implements each ordinary Nest POST route. In
manual browser mode configure the host-owned client directly.

`nv:stream.append='summary'` keeps the target's existing text when starting.
The unmodified directive clears it. Both modes write a dedicated text node,
so `<script>` and other markup remain literal text. Targets must be owned,
noninteractive, text-only HTML descendants of a valid Live component. Controls,
editable content, renderer boundaries, component roots, nested child elements,
multiple stream declarations and conflicting text/model/binding/presentation
directives are rejected.
Keep targets outside any ancestor carrying `contenteditable`, including
`plaintext-only` or `false`; this initial boundary conservatively excludes editor
containers rather than competing with their editing lifecycle.

Endpoint IDs use the closed identifier grammar. The map allows at most 64 IDs;
endpoints must use same-origin HTTP(S), without credentials, query or fragment.
Configuration is copied without invoking accessors. Client limits are eight
active streams overall and two per component, one per target. Server quotas
are independent. A target changing component, revision, snapshot, declaration,
ownership or text-node identity cancels outstanding work. Removal, disposal
and ordinary component reconciliation also release the corresponding work.

The receiver requires strict UTF-8 and ordered, request-bound records followed
by exactly one terminal record. It limits records to 8 KiB including newline,
the response to 1 MiB, text records to 4,096, total duration to 30 seconds and
idle time to 10 seconds. Rendering waits for animation frames and does not
consume an unlimited queue of chunks. Cancellation is reported as `ABORTED` to
the caller without an additional error callback. Other failures are reported
once. Partial text remains visible; hosts should label it incomplete and offer
an explicit fresh read. Browser cancellation cannot undo server work.

See [the host route and producer contract](../guides/text-streams.md), the
[client corpus](../../tests/client-stream.test.ts), the
[real Nest tests](../../tests/live-stream.test.ts), and the
[three-browser example](../../tests/browser/stream.spec.ts). This transport
does not provide HTML streaming, downloads, an AI provider, resumable replay,
distributed quotas or mutation progress semantics.
