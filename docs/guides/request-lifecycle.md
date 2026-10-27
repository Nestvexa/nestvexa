# Bounded Live requests and recovery

Live requests run serially within each component. A component admits at most 16 pending operations, suppresses duplicate pending enhanced submits and never retries a mutation automatically. Components can still have independent requests; the client does not provide a transaction across them.

## Configure the browser deadline

```js
import {
  createLiveClient,
  LiveClientError,
  LiveHttpError,
} from '@nestvexa/client';

const client = createLiveClient({
  requestTimeoutMs: 30_000,
  onError(error) {
    const code = error instanceof LiveClientError ? error.code : 'UNKNOWN';
    const status = document.getElementById('live-status');
    if (status) {
      status.textContent =
        error instanceof LiveHttpError
          ? `Request rejected (${error.status}).`
          : `Live request stopped (${code}).`;
    }
  },
});
client.mount();
```

The host supplies the optional `live-status` element and chooses its accessible status/error UI. Do not include state tokens, CSRF markers, cookies or action inputs in diagnostics.

`requestTimeoutMs` is a finite integer from 1 through 300,000ms, with 30,000ms as the default. A request's deadline starts when it leaves the queue and includes both fetch and response-body consumption. Waiting for an earlier operation does not consume the later request's deadline. Success, failure and cancellation clean up the request timer and abort listener.

The deadline races fetch and body consumption rather than relying solely on a custom transport honoring `AbortSignal`. A late completion cannot apply its response after the request has stopped. Reader/body cancellation is best-effort cleanup and does not wait for an arbitrary underlying source's cancellation promise to settle. An injected fetch implementation must still release its own external resources; the client cannot forcibly terminate arbitrary host code.

Browser timers do not preempt synchronous JavaScript and may be delayed or throttled by the browser. This is a browser request/body deadline, not a server action deadline, durable job cancellation, rollback or guaranteed wall-clock execution limit. Host server timeouts, authentication and business idempotency remain separate responsibilities.

## Response limits

The client consumes the Fetch response stream incrementally and counts at most **2,097,152 response-body bytes** before accepting the complete text. These are bytes exposed by Fetch after HTTP content decoding, not compressed network-transfer bytes or JavaScript character counts. The client rejects an oversized declared `Content-Length` early and still counts actual chunks when that header is missing or understated. The limit does not claim a process-wide memory bound for browser internals or a custom stream producer.

Only an `application/json` media type is accepted, case-insensitively, with optional parameters. A substring such as `text/xapplication/json` is rejected. UTF-8 decoding is strict, including multibyte characters split across chunks. Empty, malformed, failed or oversized bodies fail before an envelope can advance component state. JSON parsing is followed by the existing Live protocol, request identity, component identity and next-revision checks; a valid JSON body alone is insufficient.

HTTP rejections are handled without parsing or exposing their error body. The transport does not copy native fetch/reader exceptions or response text into its public transport messages.

## Errors and uncertainty

| Error                                   | Meaning                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `TIMEOUT`                               | The fetch/body deadline elapsed; the server outcome may be unknown                 |
| `NETWORK`                               | Fetch rejected; its private exception text is replaced with a stable message       |
| `RESPONSE`                              | MIME, UTF-8, byte limit, JSON or Live response validation failed                   |
| `HTTP`                                  | The server returned a rejection; `LiveHttpError.status` exposes the numeric status |
| `HTML` / post-dispatch directive errors | A received update could not be safely validated or reconciled                      |
| `MARKER`                                | Registration consistency failed; this is a separate ownership/reconciliation error |

An uncertain request failure suspends transport for the component and nested owned roots. The client aborts their pending requests, cancels scheduled directive work and prevents queued operations from reaching the network. Those queued `call()` promises reject the stored failure cause. The initiating failure is reported once through the error hook/event rather than once for every canceled operation. An unrelated sibling registration remains independent.

The component stays registered so public state, local drafts, `get()`, `set()` and references remain accessible. Loading effects restore their baselines and component `aria-busy` becomes `false`. Enhanced `nv:submit` still prevents native submission while suspended, avoiding an accidental fallback navigation or duplicate form mutation. Model edits can remain local, but no further synchronization is dispatched.

The current HTTP correction allowlist is **400, 401, 403, 404, 405, 413, 415, 422 and 429**. These rejections leave the current client registration available for an explicit corrected request. They do not cause an automatic retry, promise that permissions will recover, or prove that host application code had no effects. HTTP 408/409/410, server errors and other non-success statuses require reconciliation. A local conversion error detected before dispatch remains correctable without turning it into an uncertain network outcome.

## Recover from authoritative state

After an uncertain failure, offer a reload or a host-owned reconciliation flow. Preserve any draft the user chooses to keep, obtain authoritative state through an authenticated server path, then dispose the client and mount against trusted reconciled markup. Replacing only the failure message, calling `mount()` again on an already mounted client, or blindly remounting old markers does not reconcile an action that may already have committed.

There is no automatic replay or public “clear failure and retry” operation. For payments, orders and other irreversible effects, use host-owned durable business idempotency and outcome lookup. A disabled control, a confirmation UI, a timeout or a component revision is not a substitute.

Removing a component or disposing the client cancels its client work and settles affected promises without applying late responses. Those cancellation promises resolve under the current cleanup contract; that resolution is **not a business-success acknowledgement**. An abort can occur after the server has committed. Removal also follows the existing [DOM ownership cleanup](../reference/directives.md#explicit-replacement-and-removal-lifecycle).

`ABORTED` is the internal transport cancellation code. Normal removal/disposal suppresses that diagnostic and retains the public cleanup contract above. A parent failure is rechecked after transport settlement and before commit, so a child response that already won its fetch race cannot apply after the ancestor suspended it.

## Evidence and limits

Implementation is in [transport](../../packages/client/src/transport.ts) and the [client runtime](../../packages/client/src/index.ts). [Controlled Chromium lifecycle cases](../../tests/client-transport-lifecycle.test.ts) exercise deadlines, streams, queue isolation and cleanup; controlled responses are not Nest/server conformance evidence. [Real Nest browser scenarios](../../tests/browser/request-lifecycle.spec.ts) cover a committed action whose response times out, an actual revision conflict and connection loss after a real server response. Consult [implementation status](../implementation/STATUS.md) for executed results, packed-consumer checks and the actual compatibility matrix. Source/test presence does not establish full transport, browser, security or distributed-fault acceptance.

The implementation uses standard [Fetch body consumption](https://fetch.spec.whatwg.org/#concept-body-consume-body) and [ReadableStream reader cancellation](https://streams.spec.whatwg.org/#rs-reader-cancel) APIs. Deadline, byte-limit, failure-classification and recovery rules above are Nestvexa policy; they are not guarantees supplied by those platform specifications.

## Alpha compatibility

An injected fetch must return a standards-compatible `Response` with a readable byte stream; a text-only test facade is insufficient. Existing valid Nest JSON responses continue to work. Non-JSON media types that merely contain the string `application/json` are now rejected, and transport hooks receive stable `NETWORK` messages instead of private native exception text. Applications that previously offered another mutation after an uncertain result must provide authoritative reconciliation or reload instead. The successful response protocol and default per-component serial ordering are unchanged.
