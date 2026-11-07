---
'@nestvexa/client': minor
---

Progressive fallback for suspended components: a suspended root gets
`data-nv-suspended` for a reload affordance, and a suspended `nv:submit` form
with an explicit `action` attribute submits natively to that host route. The
failed Live request itself is never resent.
