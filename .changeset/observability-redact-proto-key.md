---
'@nestvexa/observability': patch
---

`redact()` now copies an own `__proto__` key (for example from a parsed request
body) as an ordinary logged field. Previously the assignment replaced the copy's
prototype, so that field and its contents silently disappeared from structured
logs and the copy inherited the attacker-supplied object.
