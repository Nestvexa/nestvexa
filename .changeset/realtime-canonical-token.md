---
'@nestvexa/realtime': patch
---

Realtime subscription tokens are accepted only in their canonical base64url
spelling. Alternate spellings of a valid MAC (the final character carries unused
bits) are rejected instead of decoding to the same signature.
