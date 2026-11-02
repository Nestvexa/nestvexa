---
'@nestvexa/uploads': patch
---

When an upload is rejected before its body is read (quota, type or size checks
from headers), bodies of up to 2 MiB are now drained instead of closing the
connection, so clients receive the error status rather than a connection reset.
Larger or unknown-length bodies still close the connection.
