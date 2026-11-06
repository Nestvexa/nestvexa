# Migrating to Nestvexa 1.0 (template)

Status: **template**. Fill every section from the merged changesets before the
1.0 tag; delete sections that turn out empty and say so explicitly ("No changes
to X"). Each entry must link to the changeset or pull request and to a test
that proves the new behavior. Policy: [versioning and deprecation](versioning-and-deprecation.md).

## Before you upgrade

- Supported: Node `^22.13.0 || ^24.0.0`, NestJS 12, TypeScript 6. _(Confirm
  from the release matrix.)_
- Upgrade every `nestvexa` / `@nestvexa/*` package to the same version in one
  step; mixed versions are unsupported.
- Deploy server and browser assets together. Live snapshots from the previous
  version are rejected (`409`/`426`) and pages reload; no state migrates.

## Upgrade steps

```sh
pnpm add nestvexa@1.0.0 @nestvexa/live@1.0.0   # every installed @nestvexa/* package
pnpm exec nestvexa check                       # doctor + strict TypeScript compile
```

## Breaking changes

For each item: **what changed**, **why**, **before/after code**, **how to
detect** (compile error, startup error code, runtime 4xx), **test**.

| Area      | Change | Action required | Reference |
| --------- | ------ | --------------- | --------- |
| _package_ |        |                 |           |

## Security-relevant behavior changes since 0.1.0-alpha

Already merged during the 2026-11 internal review (keep or move to "fixed in
alpha" before release):

- View identifiers and template includes reject control characters, unpaired
  surrogates and noncharacters (`@nestvexa/views`, engines).
- The EJS adapter owns `include`; EJS's own include resolution is disabled.
- Inertia encodes non-ASCII redirect targets and backslashes in request-derived
  locations.
- Upload filenames with unpaired surrogates are rejected; Live download media
  types are restricted to RFC 6838 tokens.
- `MemoryRealtimeBroker` keeps replay history for at most `replayChannels`.

## Deprecated APIs removed in 1.0

| API | Deprecated in | Replacement |
| --- | ------------- | ----------- |
|     |               |             |

## New defaults

List every default that changed, with the option that restores the old one if
any.

## Verification after upgrading

- `pnpm build && pnpm test` in your application.
- Load a Live page, run an action, reload: no `426` loops.
- Check logs for one-time deprecation warnings.

## Getting help

See [SUPPORT.md](../../SUPPORT.md). Report vulnerabilities privately per
[SECURITY.md](../../SECURITY.md).
