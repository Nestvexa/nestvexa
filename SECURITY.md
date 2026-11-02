# Security policy

No production-supported release exists yet. All `0.1.0-alpha.*` artifacts are experimental. Security fixes during this stage target the current development branch; a supported-version policy must be adopted before release.

## Reporting a vulnerability

Do not disclose exploit details in a public issue, discussion or pull request.
Report privately through GitHub's private vulnerability reporting:
[open a draft security advisory](https://github.com/Nestvexa/nestvexa/security/advisories/new).
Include the affected package and version, a minimal reproduction and the impact you
observed. Maintainers acknowledge reports and coordinate a fix and disclosure
through the advisory.

The [threat model](docs/security/threat-model.md) describes current boundaries and unimplemented protections. Dependency audit, full attack corpus, ASVS traceability and independent review are blocking release work. Passing selected automated tests is not a guarantee of security.
