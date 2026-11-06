---
'@nestvexa/views': patch
'@nestvexa/engine-hbs': patch
'@nestvexa/engine-ejs': patch
---

View identifiers now refuse control characters, unpaired surrogates and
Unicode noncharacters before any filesystem call. On Windows, Node 22/24
(libuv) abort the whole process with a failed assertion for any path that
contains U+10FFFF, so a request-influenced view or include name could crash the
server. The EJS adapter now provides its own `include` local: EJS's built-in
include probed `fs.existsSync` with the raw reference before the containment
hook ran, which allowed existence probing outside the root and, on Windows,
UNC references that contact a remote SMB host. Include semantics (aliases,
root-relative `/x`, relative references, shallow-copied locals plus data) are
unchanged.
