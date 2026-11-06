---
'@nestvexa/inertia': minor
---

Redirect Inertia requests whose handler returned nothing back to the previous
page (`emptyResponse`, default `'back'`), store the URL of successful GET pages
in the host session and use it in `back()` when the `Referer` is missing
(`previousUrl`, `InertiaService.previousUrl`), add `inertiaValidate` for
`@nestvexa/forms` adapters and the `@nestvexa/inertia/testing` entry
(`assertInertia`, `readInertiaPage`, `inertiaHeaders`).
