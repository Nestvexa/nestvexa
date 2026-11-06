---
'@nestvexa/ui': minor
---

Add React, Vue and Svelte wrappers for the main primitives (dialog/drawer,
dialog trigger, tabs, menu, toast region, date picker, data table, search,
filter, row selection and sort header) as optional entry points
`@nestvexa/ui/react`, `@nestvexa/ui/vue` and `@nestvexa/ui/svelte` (frameworks
are optional peers). They render the new framework-neutral markup contract
`@nestvexa/ui/markup`, which the HBS helpers now print as well (output is
unchanged), and connect to the keyboard module through the new `connectUi()`
(one shared document controller) and `menuSelection()` in
`@nestvexa/ui/browser`.
