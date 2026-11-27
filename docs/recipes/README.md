# Recipes

Short, task-focused answers. Each recipe quotes a runnable example verbatim (the
docs build checks every quoted block against its source file), names the tests
that prove it and links to the guide with the full reference.

| Recipe                                                          | Example                                                             | Main packages                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| [Session sign-in and a Live identity](auth.md)                  | [auth-forms](../../examples/auth-forms/README.md)                   | `nestvexa`, `@nestvexa/forms`           |
| [Scope every request to one tenant](tenant-scoping.md)          | [multi-tenant](../../examples/multi-tenant/README.md)               | every transport                         |
| [Upload files from a Live component](file-upload.md)            | [uploads](../../examples/uploads/README.md)                         | `@nestvexa/uploads`                     |
| [A realtime dashboard](realtime-dashboard.md)                   | [realtime-dashboard](../../examples/realtime-dashboard/README.md)   | `@nestvexa/realtime`                    |
| [Show background job progress](job-progress.md)                 | [realtime-dashboard](../../examples/realtime-dashboard/README.md)   | `@nestvexa/realtime` (`JobRunner`)      |
| [A Live element inside an Inertia page](inertia-live-island.md) | [inertia-mixed](../../examples/inertia-mixed/README.md)             | `@nestvexa/inertia`, `@nestvexa/client` |
| [Cache a rendered fragment](fragment-cache.md)                  | [data-cache](../../examples/data-cache/README.md)                   | `@nestvexa/cache`                       |
| [An offline-safe form](offline-form.md)                         | [offline-progressive](../../examples/offline-progressive/README.md) | `@nestvexa/offline`, `@nestvexa/forms`  |

Every example runs locally with `pnpm install --frozen-lockfile && pnpm build` and
`pnpm --filter <example package> start`; the ports are in the root
[README](../../README.md#runnable-examples). When something goes wrong, see
[troubleshooting](../troubleshooting/README.md).

The examples keep users, sessions and data in process memory and use a random
session secret per start. Production hosts supply a persistent session store,
stable secrets, HTTPS-only cookies and their own database.
