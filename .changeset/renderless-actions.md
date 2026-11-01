---
'@nestvexa/client': minor
'@nestvexa/live': minor
'nestvexa': minor
---

Add opt-in renderless Live actions. `@Action({ renderless: true })` acknowledges
the post-dehydrate state, URL effects and the next snapshot without evaluating
render hooks, computed values or the template when the client negotiates the
exact `renderless-v1` capability. The browser validates retained bindings in
place and updates `nv:text`/`nv:show`/`nv:bind` targets without an HTML morph.
Normal actions, `_sync`, unknown capabilities and stream refreshes keep full
rendering. Admission, guards, pipes, interceptors, filters, host authorization,
replay and revocation behavior are unchanged.
