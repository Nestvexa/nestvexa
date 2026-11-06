---
'@nestvexa/live': minor
'@nestvexa/client': patch
---

Optional Live decorators: `@Renderless()` (alias of `@Action({ renderless: true })`),
`@Validate(validator)` for writable state (function, Standard Schema v1 or
`safeParse` schema), `schemaPipe(schema)` for `@ActionInput`, and `@Title()`
whose value rendered responses carry as `title` (applied to `document.title`
by the client for top-level components only).
