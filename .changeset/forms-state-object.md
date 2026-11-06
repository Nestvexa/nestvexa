---
'@nestvexa/forms': minor
---

Add `defineForm`, a single JSON form-state object (fields and defaults, file
fields holding upload references, reset/clear, touched/dirty/submitted/pending,
validate/submit/view); `actionSchema(adapter)` and `FormValidationPipe` to
apply any schema adapter to `@nestvexa/actions` inputs or Nest bodies without
either package importing the other; conservative schema-derived client hints
(`zodHints`, `classValidatorHints`, `hintsFromJsonSchema`, `hintAttributes`,
`hintAttributeString`); and structural upload error mapping
(`finalizeFileField`, `uploadFormErrors`).
