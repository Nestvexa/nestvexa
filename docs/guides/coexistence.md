# Coexistence with frameworks and APIs

Nestvexa is a set of Nest modules, not an application shell. It registers its
own controllers (`/_nestvexa/...`), a view engine and, when you attach it, one
WebSocket upgrade handler. It installs no global guard, pipe, filter,
interceptor or middleware, so other Nest features keep their behavior.

## A Live element inside an Inertia page

A framework page can host an isolated Live component when each side owns a
disjoint DOM subtree. In [`examples/inertia-mixed`](../../examples/inertia-mixed/README.md)
`/react/live` renders a React Inertia page whose `LiveHost` component owns an
empty `<div>`; a Live client created with `root` set to that element owns
everything inside it:

```tsx
function LiveIsland({ html }: { readonly html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    element.innerHTML = html; // the server-rendered, signed Live mount
    const client = createLiveClient({ root: element });
    client.mount();
    return () => {
      client.dispose(); // removes listeners, aborts in-flight requests
      element.replaceChildren();
    };
  }, [html]);
  return <div ref={host} />;
}
```

The controller passes the mount as a **lazy prop**
(`live: async () => (await live.mount(Counter, request)).value`), so a partial
reload of other props neither re-mounts the component nor replaces the DOM the
Live client owns. Rules that keep the boundary safe:

- React renders no children into the host, so reconciliation never touches Live
  markup; the Live client is scoped to the host, so morphs and listeners never
  reach React's DOM.
- Dispose the client before the host leaves the document (effect cleanup). An
  Inertia visit away and back mounts a fresh server component and client.
- Do not also load `boot.js` on that page: a document-wide client would claim
  the same markers.
- The HTML prop is trusted server output of a registered component. Never pass
  user-controlled HTML through it.

`tests/browser/inertia-mixed.spec.ts` checks that Live actions are Live protocol
requests (never Inertia visits), that React state survives Live morphs and the
reverse, that a partial reload keeps the same Live DOM nodes and state, and that
leaving and returning through Inertia remounts cleanly, all in one document.

## REST, GraphQL, microservices and WebSocket gateways

[`examples/api-coexistence`](../../examples/api-coexistence/README.md) runs REST
controllers with their own guard, GraphQL (`@nestjs/graphql` with Apollo), a TCP
microservice (hybrid application), a `@WebSocketGateway` on `@nestjs/platform-ws`
and a Nestvexa page with a Live component in one process.
`tests/api-coexistence.test.ts` proves that:

- REST responses carry no Nestvexa session, CSP or Inertia headers, and unknown
  API paths keep Nest's JSON 404;
- the REST and GraphQL guards apply to their own routes and never to Live
  actions, while Nestvexa still rejects a foreign `Origin` on its own route;
- GraphQL, the microservice and the gateway share one domain service with the
  REST controller and answer normally.

**WebSocket gateways on the same port.** Nest's `WsAdapter` destroys every
WebSocket upgrade on its HTTP server whose path is not one of its gateways.
`attachRealtimeWebSocket(app)` (call it after `app.listen()`) claims upgrades
for its own path (`/_nestvexa/realtime/ws`) before any other `upgrade`
listener sees them, and leaves every other path to the gateway. A gateway on
the HTTP port and the realtime transport therefore work side by side, and so
does a gateway on its own port (`@WebSocketGateway(3001, { path })`). The test
covers both placements. In each, a page subscription receives an event
published by a REST write while the gateway answers, a bad token closes with
4003, a foreign `Origin` is refused, and unknown paths are still refused by
the gateway's server. The example runs the host's session middleware on the
raw upgrade request to resolve the realtime identity. A Socket.IO adapter on
the same server is not tested.
