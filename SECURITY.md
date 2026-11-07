# Security policy

## Supported versions

No production-supported release exists yet. All `0.1.0-alpha.*` artifacts are
experimental; security fixes during this stage target the current development
branch only.

From 1.0.0 (policy: [versioning and deprecation](docs/release/versioning-and-deprecation.md)):

| Version                       | Security fixes                              |
| ----------------------------- | ------------------------------------------- |
| Latest minor of current major | Yes                                         |
| Previous major                | For 6 months after the next major's release |
| Older, prereleases, `0.x`     | No                                          |

All `nestvexa` / `@nestvexa/*` packages share one version; fixes ship as a
coordinated patch of every package.

## Reporting a vulnerability

Do not disclose exploit details in a public issue, discussion or pull request.
Report privately through GitHub's private vulnerability reporting:
[open a draft security advisory](https://github.com/Nestvexa/nestvexa/security/advisories/new).
Include the affected package and version, a minimal reproduction and the impact you
observed. Maintainers acknowledge reports and coordinate a fix and disclosure
through the advisory.

Target timelines (best effort until maintainers beyond the owner exist):
acknowledge within 5 business days, assess severity within 10, and release a
fix or mitigation for P0/P1 issues as soon as one is verified, with an
advisory and CVE request where applicable. Reporters are credited unless they
ask otherwise.

## Scope and current assurance

The [threat model](docs/security/threat-model.md) describes boundaries and host
responsibilities. The [2026-11 internal review](docs/security/internal-review-2026-11.md)
is an internal engineering review, **not an independent third-party
assessment**; an independent review, the full release matrix and dependency
audit remain blocking 1.0 work ([release evidence](docs/release/evidence-formats.md)).
Passing selected automated tests is not a guarantee of security.

## Supply chain

- **npm provenance: configured, never exercised.** `.github/workflows/release.yml`
  publishes through npm trusted publishing (OIDC, `id-token: write`) with
  `npm publish --provenance`, and generates a CycloneDX SBOM per package
  (`scripts/sbom.mjs`). No release has been published through that workflow
  yet, so no published Nestvexa package carries a provenance attestation that
  anyone has verified. Treat provenance as a release-pipeline setting, not as
  evidence, until the first release is published and its attestation is
  checked with `npm audit signatures`.
- **License audit:** `pnpm audit:licenses` checks the production dependency
  closure of every public package (plus each declared peer) against an SPDX
  allowlist of permissive licenses and fails on copyleft, missing or unknown
  licenses (`scripts/licenses.mjs`).
- **Secret scanning:** `pnpm secrets:scan` checks every tracked and unignored
  file for high-confidence credential formats and committed `.env` files
  (`scripts/secrets.mjs`). CI runs it together with the TruffleHog action,
  pinned to a commit, over the git history (`supply-chain` job in
  `.github/workflows/ci.yml`).
- **Dependency audit:** `pnpm audit --audit-level high` runs weekly
  (`.github/workflows/security.yml`).
