---
'@nestvexa/actions': minor
---

Add `jobRunnerQueue(runner)`, which adapts `@nestvexa/realtime`'s name-registered
`JobRunner` to `ActionJobQueue` without a package dependency. Job names are
registered on first use and each accepted job's work runs in the process that
accepted it.
