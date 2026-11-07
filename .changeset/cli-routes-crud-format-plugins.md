---
'@nestvexa/cli': minor
---

- `nestvexa routes:types [--check]`: typed route map of every controller route
  with `route()` and `routeLink()` (Inertia `Link` props for React, Vue and
  Svelte) and the `{{route}}` Handlebars helper over `RouteTable`.
- `make:resource` generates Zod DTOs shared by REST and Live, a repository
  interface with `--orm memory|typeorm` (TypeORM entity and repository, no
  migration), a validated REST controller (`--crud`: list with search and pages,
  show, create, update, delete), a Live table with search and pages, and DTO,
  service and HTTP tests. Breaking for generated code: `GET /<resource>` now
  returns `{ items, total, page, size }` and the service API is asynchronous.
- Generated files are formatted with the project's own ESLint (`--fix`) and
  Prettier when they are installed (best effort; `--no-format` skips it).
- `add plugin <package> [--export <name>]` wires a `NestvexaExtension` from an
  installed package after validating its `nestvexa` manifest statically.
- Package-manager detection reads the `packageManager` field, `bun.lock` and
  lockfiles of an enclosing workspace. `make:test` adds `@jest/globals` for Jest
  projects. The `make:form` view no longer puts a Handlebars block inside a tag.
