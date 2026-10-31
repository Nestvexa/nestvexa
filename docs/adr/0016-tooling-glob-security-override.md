# 0016 — Scoped development-tool glob matcher override

Status: accepted for this repository after the full checkpoint and isolated Node22/24 checks.

The October31 detailed audit identified moderate advisory
[GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
in minimatch10.2.6, reached through ESLint, its config-array dependency and
typescript-estree. The configured high/critical audit gate returned0 while this
moderate finding existed. An audit gate pass must not be described as zero
vulnerabilities without inspecting its details.

Pin minimatch11.0.3 only for those three development-tool dependency edges in
pnpm-workspace.yaml. Registry metadata confirms Node18/20/22+ support, including
our selected22/24 runtimes. Current ESLint10.14 metadata still requests minimatch10;
upgrading ESLint alone would not remove the finding. The maintained
[v11 documentation](https://github.com/isaacs/minimatch/tree/v11.0.3) describes a
substantial matcher implementation change, so a cross-major override requires
compatibility evidence rather than an assumption of interchangeable behavior.

Before/after ESLint API probes select exactly the same131 repository files with
zero errors and warnings. Verify frozen install, complete lint/type/build/tests,
browser flows, external packed consumers, audit and both pinned Node runtimes
before accepting this checkpoint. File selection equality prevents a falsely
green lint run caused by silently losing matching files. The override is not
published in application package manifests and introduces no runtime dependency.

Rejected alternatives: leaving an avoidable known finding; globally replacing
every minimatch dependency; muting the advisory; excluding source from lint;
assuming an unrelated latest ESLint upgrade fixes its transitive constraint.

Tradeoff: these tool edges now intentionally exceed upstream declared minimatch
major ranges. Keep them pinned and tested; remove overrides when supported
upstream constraints include a patched version. This is compatibility evidence
for this repository's tooling, not all possible third-party ESLint configurations.
Windows is the executed environment; Linux remains a separate release matrix gap.
