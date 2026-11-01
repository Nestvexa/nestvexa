# Downloads, flash messages, pagination and typed state

These helpers complete the common CRUD flows of a Live page. All of them run
inside an action that has already passed admission, host authorization and Nest
guards/pipes.

## Downloads

```ts
import { Action, downloadLive } from 'nestvexa';

class ProjectBoard {
  @Action() exportCsv(): void {
    downloadLive(this, {
      filename: 'projects.csv',
      contentType: 'text/csv; charset=utf-8',
      body: csvText,
    });
  }
}
```

After the action commits, the response carries
`download: { url, filename }`. The browser triggers the download from a temporary
link. The URL is `<endpoint>/<component>/_download/<token>`:

- the token is 256 random bits, valid for 60 seconds and **single use**;
- it is bound to the identity binding that ran the action and to the component,
  so another session receives `404`;
- the body is limited to 5 MiB, held in process memory (at most 100 pending
  downloads), and served with `Content-Disposition: attachment` (ASCII fallback
  plus RFC 5987 UTF-8 filename), `X-Content-Type-Options: nosniff`,
  `Cache-Control: no-store` and `Content-Security-Policy: sandbox`;
- filenames are stripped of path separators, quotes and control characters.

Component class guards apply to the download route; the per-request identity is
resolved again. Prefer streaming host routes for large or long-lived exports.
Escape spreadsheet formulas (values starting with `=`, `+`, `-`, `@`) in CSV
output as the example does.

## Flash messages and redirects

`flashLive(this, message)` appends a message (1–500 characters, at most 8) to the
host session after the action commits. Read it in the next host route with
`consumeLiveFlash(request)`, which returns the messages and removes them. A
session is required; a failed session write revokes the advanced snapshot like
other session state. Combine it with `redirectLive(this, '/path')`; see the
[nested components guide](nested-components.md#redirects).

## Pagination

`paginate({ page, perPage, total, window? })` clamps an untrusted page number into
range (out-of-range pages resolve to the last page) and returns template-ready
metadata: `page`, `pages`, `offset`, `from`, `to`, `hasPrevious`, `hasNext`,
`previous`, `next` and windowed `links` with `gap` markers. It performs no query;
use `offset`/`perPage` in your data access. Pair it with `@Url({ key: 'page' })`
and server-built links so pagination works with and without JavaScript.

## Typed state (synthesizers)

```ts
import { DateSynthesizer, State } from 'nestvexa';

class ProjectBoard {
  @State({ synthesizer: DateSynthesizer }) updatedAt = new Date();
}
```

A synthesizer converts a typed field to public JSON and back. The component works
with the typed value (`Date`, `bigint`); snapshots, templates, computed cache
keys, validation callbacks and client updates use the JSON form.

| Synthesizer         | JSON form                                        | Rejects                                  |
| ------------------- | ------------------------------------------------ | ---------------------------------------- |
| `DateSynthesizer`   | UTC ISO-8601 string (`2026-11-01T10:00:00.000Z`) | invalid dates, offsets, rolled-over days |
| `BigIntSynthesizer` | decimal string, up to 78 digits                  | leading zeros, decimals, exponents       |

Custom synthesizers implement `{ name, dehydrate(value), hydrate(json) }` and must
throw for malformed input. They are chosen in server code only; the wire never
names a type. Client updates that fail to hydrate are rejected with
`422 STATE_TYPE`. Stored state that no longer hydrates (after a schema change)
fails with `409 STATE_SCHEMA_CHANGED`. Synthesized fields cannot also be `@Url`,
`@Session` or child props. Values are integrity-protected server-side state, not
encrypted secrets.

Tests: [server effects](../../tests/live-effects.test.ts) and the
[projects board](../../tests/browser/projects.spec.ts). Example:
[`/projects`](../../examples/starter-live/src/projects.ts).
