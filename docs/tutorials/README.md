# Tutorials

Step-by-step walkthroughs that build on the runnable examples in this repository.
Each tutorial points at real example source and the tests that exercise it, and
names what is not implemented yet. Reference material lives in the guides (for
example [forms](../guides/forms.md) and [realtime](../guides/realtime.md)) and the
[directive reference](../reference/directives.md).

| Tutorial                                  | You build                                                                | Based on                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| [Build a CRUD app with Live](crud-app.md) | A searchable, sortable, paginated project board with server validation   | `examples/starter-live` `/projects`, `nestvexa make:resource`   |
| [Add realtime updates](realtime.md)       | Cross-session refresh over SSE, owner-bound job progress, Redis broker   | `examples/starter-live` `/realtime`, `@nestvexa/realtime`       |
| [Add file uploads](uploads.md)            | Validated, resumable uploads with a no-JavaScript fallback and downloads | `examples/uploads`, `@nestvexa/uploads`                         |
| [Deploy an app](deploy.md)                | A production build behind a process manager, container and reverse proxy | The [deployment guides](../deployment/node-process-managers.md) |

## Before you start

- Node 22.13+ or 24 and an Express-based NestJS 12 project. The CLI's `init`
  command supports Express hosts; Fastify hosts wire the modules by hand (see the
  [CLI reference](../reference/cli.md)).
- To run the examples from this repository instead:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @nestvexa/example-starter-live start   # http://127.0.0.1:3102
pnpm --filter @nestvexa/example-uploads start        # http://127.0.0.1:3105
```

The examples use an in-memory guest session with a random secret. They are
demonstrations, not production starters: every tutorial ends with the changes a
real deployment needs. Read the [security guide](../security/guide.md) before you
ship anything built from them.
