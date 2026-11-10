// The state's schema (ADR 0085) on the pieces #671 met: what this version writes reads back equal, and the shape an
// older version stored is refused. Every demo scenario's whole state is read in the service's scenario tests.
import { expect, test } from "bun:test";
import { type Repository, repositoryId, type Service, stateSchema } from "./index.ts";

const serviceSchema = stateSchema.shape.service;
const repositorySchema = stateSchema.shape.repos.element;

const SERVICE: Service = {
  state: "running",
  since: 1_000,
  version: "0.12.0",
  command: "lookover",
  agent: { path: { folder: "/home/sam/.local/bin", reach: "yes" }, offer: "binary", skills: [] },
  startAtLogin: true,
  atLogin: "this",
  loginItem: "os",
  paused: null,
  remote: false,
  unlocked: false,
  checks: {
    at: 2_000,
    running: false,
    items: [
      {
        check: "service",
        state: "running",
        startAtLogin: true,
        atLogin: { other: "C:\\old\\lookover.exe" },
        loginItem: "os",
      },
    ],
  },
};

test("a service as this version writes it reads back equal", () => {
  expect(serviceSchema.parse(SERVICE)).toEqual(SERVICE);
});

test("the service check 0.3.0 stored (`startsAtLogin`, no `atLogin`, #671) is refused, not read half", () => {
  const stored = {
    ...SERVICE,
    checks: {
      at: 2_000,
      running: false,
      items: [{ check: "service", state: "running", startsAtLogin: true }],
    },
  };
  expect(serviceSchema.safeParse(stored).success).toBe(false);
});

test("a repository keeps its optional counts when it has them, and reads without them", () => {
  const setting = <V>(value: V) => ({ value, origin: "lookover-default" as const, overrode: null });
  const repo: Repository = {
    id: repositoryId("sam/app"),
    owner: "sam",
    name: "app",
    enabled: true,
    settings: {
      strictness: setting("recommended" as const),
      reviewers: setting("both" as const),
      depth: setting("standard" as const),
      onOpen: setting(true),
      onPush: setting(false),
    },
  };
  const counted: Repository = {
    ...repo,
    noise: { reviews: 12, postedBelowBlocking: 3, raisedByRule: { r1: 2 } },
  };
  expect(repositorySchema.parse(repo)).toEqual(repo);
  expect(repositorySchema.parse(counted)).toEqual(counted);
  expect(repositorySchema.safeParse({ ...repo, id: " " }).success).toBe(false);
});
