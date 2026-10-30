# Browser fixture scheduling and cleanup

The aggregate Vitest suite includes real Chromium processes as well as pure unit
and Nest HTTP tests. Its default `maxWorkers` is **2** to bound browser/CPU/memory
contention on developer and CI hosts. Test files and assertions remain included;
no retries or exclusions are added. Playwright's full three-engine suite has its
own separate two-worker configuration. These settings are execution choices,
not proof that every hardware/browser combination is supported.

The isolated Node compatibility runner allows five minutes per command because
the aggregate runs with bounded concurrency. Individual Vitest test/hook limits
remain 15/30 seconds. A suite timeout, failure or unhandled error still fails the
runner. Read actual command timings in checkpoint reports rather than assuming
the deadline is a measured runtime or performance budget.

Installing Playwright's clock does not pause it. Timer-cancellation fixtures that
make several automation calls pause the clock before mounting the client, then
advance it explicitly with `runFor`. This prevents a 100ms debounce from firing
during an unrelated automation round trip before the fixture removes/reparents a
control. The fixture still executes the real browser scheduler and product cleanup;
it does not replace timer behavior with an immediate fake success. See the
[model lifecycle tests](../../tests/client-model-lifecycle.test.ts) and
[Playwright clock contract](https://playwright.dev/docs/clock).

The native-control/reset asset-server fixtures close pages and browsers before
requesting HTTP server closure and releasing remaining connections. These
servers provide test assets, not production uploads or long-running business
streams. Explicit connection cleanup belongs to fixture teardown and must not
be copied as a production graceful-shutdown policy that drops active requests.
See [Node HTTP closeAllConnections](https://nodejs.org/api/http.html#servercloseallconnections)
and [Vitest worker configuration](https://vitest.dev/config/maxworkers).

Failures remain recorded in the implementation report. A fresh full checkpoint
must pass after fixture changes; a scoped rerun alone does not establish release
readiness or erase an earlier failure.
