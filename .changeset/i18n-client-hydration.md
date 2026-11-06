---
'@nestvexa/i18n': minor
---

Add explicit client locale hydration: `I18n.hydration()` publishes selected
namespaces/keys, `hydrationScript()` writes a script-safe JSON element, and the
new `@nestvexa/i18n/client` entry validates the payload and translates in the
browser with the same ICU subset.
