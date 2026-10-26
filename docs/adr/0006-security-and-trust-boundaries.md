# ADR 0006: Trusted templates, untrusted view data

Status: accepted for the MVC foundation.

Application templates/helpers execute with application privileges and require code review. View data is untrusted; normal interpolation must escape it. Trusted HTML branding represents explicit application trust, not sanitization. Browser-selected filesystem paths are disallowed and resolved template files must remain under the configured real root, including symlinks.

Rejected: accepting arbitrary absolute template filenames, treating signed browser data as secret, or promising CSRF based on a boolean option. The current release contains no mutation endpoint. Hosts must protect their own routes; future Live endpoints must fail closed without verified CSRF and identity context.

Failure modes include raw triple-brace use, unsafe custom helpers, HTML-context confusion and symlink swaps by a filesystem attacker. Templates must be deployed read-only from trusted sources. [Security tests](../../tests/security.test.ts) and [engine tests](../../tests/views.test.ts) cover implemented boundaries. Independent security review and the full ASVS mapping remain unmet release gates.
