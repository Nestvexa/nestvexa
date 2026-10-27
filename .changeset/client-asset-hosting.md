---
'nestvexa': minor
---

Add the explicit `nestvexa/assets` entry point with an application-local Nest asset module and immutable content-addressed manifest. Serve only approved Live, Alpine adapter and Alpine CSP modules through version-neutral Nest routes; support conditional GET/HEAD and reject unknown versions/files without immutable caching. No request-controlled filesystem path is resolved.

The umbrella distribution now declares the client, Alpine adapter and pinned Alpine CSP dependencies. MVC imports remain free of browser initialization; hosts still register Live security policies and explicitly start the client/Alpine. The example consumes manifest URLs instead of maintaining a route per browser module.
