# Contributing

Thanks for your interest in contributing to `ivn`.

Before participating, read [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) and [`SECURITY.md`](SECURITY.md).

## Before You Start

- Open an issue for significant changes before starting work
- Use the bug report and feature request templates when they fit
- Keep pull requests focused and small when possible
- Update docs and tests with code changes

## Development Setup

```bash
npm install
npm run build
npm test
```

Useful commands:

```bash
npm run lint
npm run typecheck
npm run release:check
node scripts/install-smoke.mjs <path-to-tarball>
```

## Project Expectations

- Prefer local-first behavior and explicit review flows
- Preserve compatibility for generated knowledge artifacts and adapters
- Keep user-facing command names, docs, and release checks in sync
- Add or update tests for behavior changes

## Pull Requests

- Describe the motivation, not just the code diff
- Mention any user-visible changes to CLI behavior, generated files, or MCP contracts
- Include validation steps you ran locally

## Maintainer Release Flow

Use this checklist for the first release and future npm publishes:

```bash
npm run check
npm run release:check
npm pack --dry-run
node scripts/install-smoke.mjs <path-to-tarball>
```

Then:

- Bump `package.json` and `src/version.ts` together
- Confirm `repository`, `homepage`, and `bugs.url` still point at the canonical GitHub repo
- Push the release commit and tag it as `vX.Y.Z`
- Ensure the GitHub repository has `NPM_TOKEN` configured for the release workflow
- Let `.github/workflows/release.yml` publish the package with npm provenance

## Code Style

- TypeScript ESM
- Biome for linting and formatting
- ASCII by default unless the file already uses broader Unicode
