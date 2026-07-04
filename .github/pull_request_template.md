## What does this change?

<!-- What changed, and why. Link an issue if one exists. -->

## How was this tested?

<!-- pnpm -r typecheck / build / test / lint, cargo fmt/clippy/test, manual verification, etc. -->

## Checklist

- [ ] `pnpm -r typecheck && pnpm -r build && pnpm -r test && pnpm -r lint` pass locally
- [ ] `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` pass locally (if the Rust shell was touched)
- [ ] No new telemetry, network calls, or cloud dependencies were introduced (RaioPDF stays fully local — see [the philosophy](../README.md#the-philosophy))

## Feature-acceptance canary

<!-- Required if this PR touches apps/ui, the engine sidecar/host, or the payload.
     Run `pnpm prepare:shell-bundle` (once) then `pnpm canary`. See docs/RELEASE-CANARY.md. -->

- [ ] N/A — doesn't touch `apps/ui`, the engine, or the payload
- [ ] `pnpm canary` passes against the real build — summary:

```
paste the canary summary, e.g. "10 passed"
```
