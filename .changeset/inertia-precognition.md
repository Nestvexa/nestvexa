---
'@nestvexa/inertia': minor
---

Add Inertia v3 Precognition support: `@Precognitive(validator)` answers
`Precognition: true` requests with validation only (`204` +
`Precognition-Success: true`, or `422` with `{ message, errors }` filtered by
`Precognition-Validate-Only`) without running pipes or the handler, adds
`Vary: Precognition` to every response of the route, and accepts any
`@nestvexa/forms` schema adapter structurally (no hard dependency).
`InertiaValidationFilter` answers precognitive requests with the `422` reply
instead of a redirect.
