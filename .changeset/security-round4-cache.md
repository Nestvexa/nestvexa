---
'@nestvexa/cache': patch
---

`cacheKey` refuses private identity bindings that contain unpaired surrogates.
UTF-8 hashing replaced each of them with U+FFFD, so distinct malformed bindings
(and a binding containing a literal U+FFFD) shared one private cache key.
