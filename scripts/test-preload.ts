// Loaded before every test file by `bun test` run from this repository (bunfig.toml's `[test] preload`): marks the
// process as the test runner's, whatever `NODE_ENV` says, so the real start at login refuses to run (ADR 0045, ADR
// 0054; `underTest` in apps/service/src/config.ts). Child processes a test starts inherit the mark.
process.env.LOOKOVER_UNDER_TEST = "1";
