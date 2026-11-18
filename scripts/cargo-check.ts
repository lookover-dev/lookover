// `bun run cargo:check`: the tray helper's crate, `apps/tray`, checked (ADR 0105 §15). It fetches the crates
// `Cargo.lock` pins (`cargo fetch --locked`: the build's network, once, as `bun install`'s is), then runs offline
// `cargo fmt --check`, `cargo clippy --all-targets --locked --offline -- -D warnings` and
// `cargo test --locked --offline`, the crate's own tests, which drive a fake tray and draw nothing. Each step's
// output is shown as it comes; the first that fails stops it. The crate's toolchain is its `rust-toolchain.toml`'s,
// which rustup installs on the first run.
//
// `--frozen` is how `bun run check` (when the change reaches `apps/tray`) and `check:full` run it: nothing is fetched
// (hard rule 1). It first asks Cargo, offline, whether every locked crate and the toolchain are on the machine, and
// when they aren't says to run `bun run cargo:check` once; then format, then lint and test `--frozen`, rustup
// installing no toolchain (`RUSTUP_AUTO_INSTALL=0`). The steps are `cargoCheck` in `scripts/cargo.ts`.
//
// Exit 0 when every step passed, 1 at the first that failed or when Cargo can't be found (it says how to install it).
import {
  askCargo,
  cargoCheck,
  FETCHED_PROBE,
  machineCargo,
  NO_CARGO,
  notFetched,
  runCargo,
} from "./cargo.ts";

const frozen = process.argv.includes("--frozen");
const cargo = machineCargo();
if (cargo === undefined) {
  console.error(NO_CARGO);
  process.exit(1);
}
if (frozen) {
  const probe = askCargo(cargo, FETCHED_PROBE.args, FETCHED_PROBE.env);
  if (probe.code !== 0) {
    console.error(notFetched(probe.said));
    process.exit(1);
  }
}
for (const step of cargoCheck(frozen ? "frozen" : "fetch")) {
  const started = performance.now();
  const code = await runCargo(cargo, step.args, step.env);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (code !== 0) {
    console.error(`cargo:check: ${step.name} (cargo ${step.args.join(" ")}) failed with exit code ${code}`);
    process.exit(1);
  }
  console.log(`cargo:check: ${step.name} passed in ${seconds} s`);
}
