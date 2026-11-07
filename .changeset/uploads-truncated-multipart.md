---
'@nestvexa/uploads': patch
---

A truncated `multipart/form-data` body no longer escapes as an uncaught "Unexpected end of form" exception: parser and part-stream errors stay handled for the whole request, and cleanup waits for queued part writes so no temporary file leaks.
