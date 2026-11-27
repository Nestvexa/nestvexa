---
'@nestvexa/live': minor
---

`@State` refuses field names that look like credentials (`password`, `token`,
`secret`, `apiKey`, `session`, `cookie`, `csrf`, `credential`,
`authorization`, `privateKey`; the same pattern islands refuse in props) at
class definition, because Live state is public page data. Opt out per field
with a reason: `@State({ allowSensitiveName: '...' })`. Existing components with
such field names must rename them or add the opt-out.
