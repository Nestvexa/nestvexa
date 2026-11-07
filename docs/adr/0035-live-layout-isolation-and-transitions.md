# ADR 0035: No Live layout, isolation or transition options

Date: 2026-11-07. Status: **accepted**. Records a decision already in force in
`@nestvexa/live` that had been explained only in the package README (ledger rows
LIVE-003 and LIVE-014). Related: [ADR 0004](0004-renderers-and-islands.md),
[ADR 0021](0021-nested-components-and-events.md) and
[ADR 0031](0031-live-protocol-evolution-and-action-replay.md).

## Context

Section 8 of the specification sketches
`@LiveComponent({ name, view, layout?, lazy?, isolated?, ... })` and lists
optional `@Renderless`, `@Transition`, `@Title`, `@Layout` and `@Validate`
decorators "where meaningful". The shipped `ComponentOptions` accepts `name`,
`view`, `children`, `lazy`, `placeholder` and `timeoutMs`
(`packages/live/src/metadata.ts`). `@Renderless`, `@Title` and `@Validate` ship
and are tested in `tests/live-optional-decorators.test.ts`. The other three
names had no recorded decision.

In Livewire these names exist because Livewire owns parts of the page that
Nestvexa leaves to other layers:

- A **layout** wraps a full-page component that Livewire routes itself. Nestvexa
  Live never owns a page route: a host Nest controller renders the page with its
  view engine (`@Render`, `RenderOptions.layout`, engine `defaultLayout`) and
  mounts components inside it.
- **Isolation** opts a component out of request bundling, where Livewire sends
  the updates of several components in one request. Nestvexa never bundles:
  every component action is its own generated Nest route, with its own guards,
  snapshot, revision and failure scope (ADR 0021, ADR 0031).
- A **transition** decorator would configure an enter/leave animation from
  server code. Animation is browser presentation, which the `nv:transition`
  directive already covers ([reference](../reference/nv-transition.md),
  `tests/client-presentation.test.ts`).

## Decision

1. `@LiveComponent` has no `layout` and no `isolated` option, and Live exports
   no `@Layout` or `@Transition` decorator.
2. Layouts belong to the host route that renders the page. Components render
   their own view only; a lazy component may name a `placeholder` view.
3. Every component is isolated by construction. Cross-component batching stays
   rejected, so an `isolated` flag would have nothing to switch off.
4. Transitions are declared in templates with `nv:transition` and its
   `.enter`/`.leave` stage attributes; the server sends no animation data.
5. `@Title()` stays the only page-level hint a component can send. It sets
   `document.title` for top-level components and nothing else.

## Rejected alternatives

- **Accept the options and ignore them.** This keeps spec-shaped call sites but
  gives no behavior. Readers would believe a layout or isolation guarantee
  exists. TypeScript already rejects unknown keys in an object literal.
- **Full-page Live components with a `layout`.** Live would need to register
  page routes, choose a layout per request and own the document head. That
  duplicates the host's MVC layer, adds a second route owner next to Nest
  controllers, and blurs the renderer ownership rules of ADR 0004.
- **`@Transition` as server metadata copied into the wrapper.** The same
  attributes can be written in the template, where the markup lives. A
  decorator would add protocol surface and client code (against the 48 KiB gzip
  budget) for no new capability.

## Trade-offs and cost

- Porting from Livewire costs a small rewrite. A full-page component becomes a
  controller route that renders a layout and mounts the component.
  `#[Transition]` becomes `nv:transition` in markup. `#[Isolate]` is dropped.
  The [Livewire migration guide](../migration/from-livewire.md) maps the
  directives.
- No layout swapping happens during Live navigation. Changing the layout is a
  normal page load, which the host controls.
- Each component already pays for its own request. Dropping `isolated` changes
  nothing at runtime.

## Failure modes and compatibility

- A JavaScript caller, or a cast object, can pass `layout` or `isolated` at
  runtime. `@LiveComponent` does not read them, so they have no effect. They
  never change routing, authorization or rendering.
- If a later release adds one of these names, it must be a new opt-in option
  with tests and an amendment to this ADR. No current call site depends on the
  names, so adding them is not a breaking change.
- If cross-component batching is ever accepted (it would need per-item
  admission and partial-failure semantics, ADR 0031), the isolation question
  reopens and this ADR must be amended first.

## Evidence

- `tests/live-optional-decorators.test.ts`: the decorators that do ship
  (`@Renderless`, `@Validate`, `schemaPipe`, `@Title`).
- `tests/live-instance-scope.test.ts`: a fresh component instance per
  operation, with independent action state for same-type mounts.
- `tests/live-nesting.test.ts`: keyed children get their own snapshots, every
  child mount is authorized, and a lazy component renders its placeholder first.
- `tests/client-presentation.test.ts` and
  `tests/client-directive-grammar.test.ts`: `nv:transition` stages and grammar.
- [`packages/live/README.md`](../../packages/live/README.md) lists this as a
  limit by design.
