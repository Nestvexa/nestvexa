# Phase 4 acceptance review

Status: **implementation complete for tasks 4.1–4.8 on the executed Windows
environment; residual combination-matrix acceptance is tracked per ledger row.**
Overall release remains blocked. This review follows the untouched master
specification (Phase 4) and does not accept other phases.

| Task | Implemented contract                                                                                                                                                   | Principal evidence                                                                                                                                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1  | `@Url`, `@Session`, `@Prop`, `@Reactive`, `@Modelable`, `@OnEvent`/`dispatchLiveEvent`, independent child snapshots and queues                                         | `tests/live-state-context*.test.ts`, `tests/live-nesting.test.ts`, `tests/browser/nesting.spec.ts`, `tests/browser/activity.spec.ts`                                                                                                                                      |
| 4.2  | Server-mounted keyed children (`nvChild`, stub/refresh/graft protocol, revocation), full hook set, per-instance computed invalidation, Date/BigInt/custom synthesizers | `tests/live-nesting.test.ts`, `tests/live-lifecycle-hooks.test.ts`, `tests/live-computed*.test.ts`, `tests/live-effects.test.ts`                                                                                                                                          |
| 4.3  | `nv:init`, `nv:poll`, `nv:intersect`, `nv:offline`, `nv:confirm`, `nv:transition`, `nv:sort`, `nv:current`, `nv:stream`, `nv:navigate`                                 | `tests/client-observers.test.ts`, `tests/client-presentation.test.ts`, `tests/client-sort.test.ts`, `tests/client-stream.test.ts`, `tests/client-optimistic-navigation.test.ts`, browser specs `activity`, `sort`, `stream`, `confirmation`, `initialization`, `projects` |
| 4.4  | Lazy/visible components with placeholders, renderless actions, per-component isolation (no guard-bypassing batch endpoint, ADR 0021), GET progressive forms            | `tests/live-renderless.test.ts`, `tests/live-nesting.test.ts`, `tests/browser/renderless.spec.ts`, `tests/browser/nesting.spec.ts`, `tests/browser/projects.spec.ts`                                                                                                      |
| 4.5  | Application-relative redirects, session flash, single-use identity-bound downloads, `paginate`, `nv:navigate` history/scroll/focus/title restoration                   | `tests/live-effects.test.ts`, `tests/browser/projects.spec.ts`                                                                                                                                                                                                            |
| 4.6  | `nv:optimistic` data-literal projections with rollback events; revision-based anti-duplication; suspension on uncertain failures                                       | `tests/client-optimistic-navigation.test.ts`, `tests/client-transport-lifecycle.test.ts`, `tests/browser/projects.spec.ts`                                                                                                                                                |
| 4.7  | Nested team board and projects CRUD board in Chromium, Firefox and WebKit, including axe checks and the production minified bundle served by the default asset route   | `tests/browser/nesting.spec.ts`, `tests/browser/projects.spec.ts`, `tests/browser/assets.spec.ts`                                                                                                                                                                         |
| 4.8  | Reference pages and guides for directives, lifecycle, nesting, effects, serialization and limits                                                                       | `docs/reference/*.md`, `docs/guides/nested-components.md`, `docs/guides/live-effects.md`, ADRs 0011–0021                                                                                                                                                                  |

## Exit gate

The exit example is `/projects` in `examples/starter-live`: a session-scoped CRUD
board with debounced live search, server sorting, URL pagination that works with
and without JavaScript, keyed row children with reactive props, server validation
announced next to the field, confirmed deletion delivered through a child event,
a toast component listening to events, optimistic stars with real rollback, a
single-use CSV export and an archive action that redirects with a flash message.
Its browser tests use the real Nest endpoints in three browsers.

## Residual items (not hidden)

- Directive rows DIR-004–DIR-008, DIR-015–DIR-017, DIR-019–DIR-022, DIR-024–DIR-026
  stay **InProgress**: every directive is implemented and browser-tested, but the
  exhaustive modifier/input/assistive-technology combination matrix requested by
  section 8.3 is not complete.
- Framework island placeholders depend on Phase 12; progressive POST mutation
  fallbacks belong to Phase 5 forms; file attachments to Phase 6 uploads.
- Server-originated domain events (broker push) belong to Phase 13.
- Linux execution and the full release matrix remain unexecuted.
