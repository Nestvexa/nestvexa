---
'@nestvexa/ui': minor
---

Add form-field wrappers (`uiTextField`, `uiTextareaField`, `uiSelectField`,
`uiCheckboxField`, `uiRadioGroupField`) that wire label, hint and error with
`for`/`id`, `aria-describedby`, `aria-invalid` and `required`, accept a
`@nestvexa/forms` field view and pass Live `nv:model` through, and a CSP-safe
chart wrapper (`uiChart`: server-rendered SVG bar, line and sparkline charts
with an always-present data table, or a container for a third-party chart),
with matching React, Vue and Svelte components, theme styles and chart color
tokens, and `chartData()` in the browser module.
