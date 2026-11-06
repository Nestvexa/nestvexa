---
'@nestvexa/inertia': patch
---

The version-mismatch `X-Inertia-Location` built from the request URL now
percent-encodes backslashes and C0 controls. Browsers and the official client's
`new URL()` treat `\` as `/`, so a request path such as `/\evil.example` could
resolve to another origin. Redirect targets containing non-ASCII characters are
now percent-encoded as UTF-8 instead of making Node reject the header (a 500);
ASCII targets are returned byte-for-byte and unpaired surrogates are refused.
