---
'@nestvexa/client': patch
---

Fix `nv:navigate`: Forward now restores scroll as well as Back (the client owns
`history.scrollRestoration` while mounted), named and Open Graph `<meta>`
elements follow the incoming document, the clicked link's fragment survives
redirects, Back/Forward fallbacks use `location.replace` instead of adding a
history entry, swapped components are registered before Alpine initializes
their `$live` reads, the current page is never prefetched, and any committed
Live request clears the prefetch cache.
