---
'@nestvexa/uploads': patch
'@nestvexa/live': patch
---

Download filename hardening found by the 2026-11 property-based review.
`parseClientFilename` now refuses names containing unpaired UTF-16 surrogates,
and `contentDisposition` replaces them with U+FFFD and truncates by code point,
so a stored or host-supplied name can no longer make `encodeURIComponent`
throw (a 500 on download). Live `downloadLive` filenames get the same
treatment and additionally drop C1 controls and bidi/invisible formatting
characters (display spoofing such as `invoice<U+202E>fdp.exe`). The Live download
content-type check again uses the intended RFC 6838 character set; it had
accepted spaces, `*`, `,` and extra `/` since its introduction.
