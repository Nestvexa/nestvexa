// `pnpm docs:build` entry point. The documentation site builder and its checks
// live in apps/docs (see apps/docs/README.md and docs/adr/0027-documentation-site.md).
await import('../apps/docs/src/build.mjs');
