---
'@nestvexa/engine-hbs': minor
---

Add `HbsEngine.registerHelpers(helpers)` so optional packages can add trusted
engine-wide helpers to an umbrella-owned engine before initialization, and
forward the Handlebars context to helpers so trusted block helpers can render
their body with `options.fn(this)`. Registration locks at `initialize()` or the
first render and rejects duplicates and the reserved `nv` + uppercase prefix.
