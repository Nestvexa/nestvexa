---
'@nestvexa/cache': minor
---

Add `FragmentCache`, a read-only fragment cache for HBS (and other view-engine)
partials on top of `RenderCache`: every fragment names an explicit key and
audience, the template renders without a layout from its own `model()` loader
(called only on a miss, refresh or bypass), results are `SafeHtml` for the page
model, private fragments are never stored unless the `RenderCache` opts in with
`cachePrivate`, and `renderAll()` renders several fragments concurrently with
per-fragment statuses. `@nestvexa/cache` now depends on the dependency-free
`@nestvexa/views` contract.
