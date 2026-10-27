---
'@nestvexa/client': minor
---

Add empty `nv:ignore.self` on non-editable wrappers: retain browser-owned attributes while child Live directives and native controls continue to reconcile. Preflight the effective incoming markup before validation and form ownership resolution, reject frozen directive changes and competing attribute effects, and replace wrappers when switching between ordinary and self ownership.

Reject malformed whole-ignore declarations explicitly. Native control roots, editable wrappers and independent renderer roots require other documented ownership boundaries. The bare `nv:ignore` parser result is unchanged.
