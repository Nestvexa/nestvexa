---
'@nestvexa/views': patch
'@nestvexa/vite': patch
---

Resolve template roots and the Vite dev root with the native realpath so Windows
8.3 short paths (for example `C:\Users\RUNNER~1`) no longer make valid includes
look like root escapes or fall outside Vite's serving allow list.
