# Release evidence formats

`pnpm release:check` ([script](../../scripts/release-check.mjs)) reads these
machine-readable reports from `artifacts/reports/`. Validators may only gain
conditions; relaxing one requires an ADR and owner approval. A missing,
unreadable or failing file blocks the release.

| File                   | Producer                                                       | Gate                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest.json`          | `pnpm test` (vitest JSON reporter)                             | `success`, no failed or pending tests, at least one test                                                                                 |
| `playwright.json`      | `pnpm test:e2e`                                                | no unexpected or skipped tests, at least one expected                                                                                    |
| `pack.json`            | `pnpm test:pack` ([pack.mjs](../../scripts/pack.mjs))          | passed; npm and pnpm consumers passed; one version for all packages; each tarball SHA-256 and a verified CycloneDX SBOM                  |
| `release-matrix.json`  | [release-matrix.mjs](../../scripts/release-matrix.mjs) `merge` | passed; one 40-hex `commit`; every environment passed; Linux and Windows; Node 22 and 24                                                 |
| `security-review.json` | owner, from the independent review                             | approved; `openP0` and `openP1` are 0; `reviewedCommit`; at least one reviewer with `independent: true`; no P0/P1 finding unless `fixed` |
| `load.json`            | `pnpm load` ([load.mjs](../../scripts/load.mjs))               | passed with `latencyGate: "enforce"`; realtime hub and every memory check passed                                                         |

The ledger (`node scripts/ledger.mjs release`) and phase tracker must also be
complete.

## `pack.json` package entries

```json
{
  "name": "@nestvexa/live",
  "version": "1.0.0",
  "tarball": "…/artifacts/packages/nestvexa-live-1.0.0.tgz",
  "sha256": "<64 hex>",
  "sbom": {
    "format": "CycloneDX 1.6 JSON",
    "file": "artifacts/sbom/nestvexa-live-1.0.0.cdx.json",
    "sha256": "<64 hex of the SBOM file>",
    "components": 5
  }
}
```

The check re-hashes the SBOM file and requires `metadata.component.hashes` to
contain the tarball SHA-256. SBOM contents are described in
[sbom.mjs](../../scripts/sbom.mjs): runtime dependency closure from the
lockfile (scope `required`, registry SHA-512), peers (scope `optional`), and
workspace siblings with their tarball hash.

## `release-matrix.json`

```json
{
  "schemaVersion": 1,
  "commit": "<40 hex>",
  "passed": true,
  "environments": [
    {
      "schemaVersion": 1,
      "commit": "<40 hex>",
      "os": "linux",
      "arch": "x64",
      "node": "24.11.0",
      "nest": "12.2.0",
      "typescript": "6.0.3",
      "httpAdapters": ["express", "fastify"],
      "browsers": ["chromium", "firefox", "webkit"],
      "checks": [
        "format",
        "typecheck",
        "lint",
        "test",
        "coverage",
        "size",
        "e2e",
        "pack",
        "docs"
      ],
      "runUrl": "https://github.com/<owner>/<repo>/actions/runs/<id>",
      "passed": true,
      "timestamp": "2026-11-06T00:00:00.000Z"
    }
  ]
}
```

Entries are written by the last step of each matrix job in
[release.yml](../../.github/workflows/release.yml), so an entry exists only when
every earlier check in that job passed.

## `security-review.json`

Committed by the owner as `docs/release/evidence/security-review.json`; the
release workflow copies it into `artifacts/reports/`. The internal review
([internal-review-2026-11](../security/internal-review-2026-11.md)) is **not**
sufficient: it has no independent reviewer.

```json
{
  "schemaVersion": 1,
  "reviewedCommit": "<40 hex>",
  "reviewDate": "2026-12-01",
  "reviewers": [
    { "name": "<firm or person>", "organization": "<org>", "independent": true }
  ],
  "scope": ["packages/*", "examples/*", "release workflow"],
  "methodology": "OWASP ASVS 5.0 L2 + source review + dynamic testing",
  "findings": [
    {
      "id": "NV-2026-001",
      "severity": "P2",
      "status": "fixed",
      "reference": "<advisory or PR>"
    }
  ],
  "openP0": 0,
  "openP1": 0,
  "approved": true,
  "reportUrl": "<private location of the full report>"
}
```

Severity scale: P0 remote compromise or cross-tenant data exposure by default
configuration; P1 exploitable with plausible configuration or user
interaction; P2 defense-in-depth gap or DoS needing unusual conditions; P3
hardening/documentation. Findings that are `accepted` need a written
rationale in the report.

## `load.json`

Top-level keys: `timestamp`, `node`, `platform`, `cpus`, `config` (including
`latencyGate`, `liveSessions`, `liveOfferedRate`), `thresholds`, `scenarios[]`
(req/s, latency p50/p90/p99/max, errors, timeouts, non-2xx), `memory[]` (heap
samples after full GC, growth, least-squares slope per minute), `realtimeHub`,
`failures[]`, `advisories[]`, `passed`. A release run uses
`LOAD_LATENCY_GATE=enforce` on a dedicated runner.
