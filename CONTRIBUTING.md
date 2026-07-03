# Contributing to RaioPDF

RaioPDF is pre-alpha and solo-maintained, so process is intentionally light. Thanks for taking the time to contribute.

## Before you start

- For anything beyond a small fix (a new feature, a redesign of a workflow, a new dependency), open an issue first to discuss the approach. It's pre-alpha and things are moving fast, so a quick sync avoids wasted work on either side.
- Check open issues and PRs first — someone may already be on it.
- By contributing, you agree your contribution is licensed under the project's [GPL-3.0 license](LICENSE).

## Project layout

This is a pnpm workspace with a Rust/Tauri shell:

| Path | What it is |
|---|---|
| `apps/` | The Tauri desktop shell + the web UI |
| `engine/` | Vendoring/build scripts for the bundled Stirling-PDF engine |
| `packages/` | Shared TypeScript packages (including the engine sidecar) |
| `installer/` | Windows installer + code-signing config |
| `site/` | Marketing site (raio.macrify.me) |
| `docs/` | Architecture notes |

## Development setup

```bash
corepack enable          # gets you the right pnpm version (see packageManager in package.json)
pnpm install --frozen-lockfile
pnpm dev                 # web UI dev server
pnpm dev:shell           # full Tauri desktop shell
```

Requires Node 24+ and, for the shell, a Rust toolchain (stable) plus the platform build deps used in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (on Linux: `libayatana-appindicator3-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libwebkit2gtk-4.1-dev`, `patchelf`).

## Before opening a PR

Run what CI runs, so you're not waiting on a red build to find out:

```bash
pnpm -r typecheck
pnpm -r build
pnpm -r test
pnpm -r lint

# Rust shell
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

- Keep PRs focused — one logical change per PR is easier to review and easier to revert if something's wrong.
- Write a clear PR description: what changed and why, not just what.
- CI (`Web` + `Shell` jobs) must pass before merge — required checks are enforced on `main`.
- PRs merge as a single squashed commit, so don't worry about tidying up commit-by-commit history within your branch.

## Reporting bugs

Open a [GitHub issue](https://github.com/Macrify-LLC/raiopdf/issues/new/choose) with:

- What you expected vs. what happened
- Steps to reproduce
- OS/version, and the RaioPDF version if you have a build
- A sample PDF, if the bug is file-specific and you're comfortable sharing it (strip anything sensitive first — this is a legal-document tool, and issues are public)

**Found a security issue?** Don't open a public issue — see [SECURITY.md](SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be respectful; disagreements about code are fine, personal attacks aren't.
