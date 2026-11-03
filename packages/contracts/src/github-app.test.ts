// The shared App's installations (ADR 0053, ADR 0073): the links to GitHub's pages, built on the connection's web
// address, and the cause a host's refusal gives the connection.
import { expect, test } from "bun:test";
import { connectionCauseOf, DEMO_API, GITHUB_WEB, githubLinks, HostError } from "./index.ts";

const SAM = { id: 7, login: "sam", type: "User" } as const;

test("every link to GitHub is built on the web address the service gives, GitHub's or demo mode's fake", () => {
  const repo = { owner: "sam", name: "app" };
  expect(githubLinks.install(GITHUB_WEB, "lookover-k3x9q2")).toBe(
    "https://github.com/apps/lookover-k3x9q2/installations/new",
  );
  expect(githubLinks.installation(GITHUB_WEB, SAM, 77)).toBe("https://github.com/settings/installations/77");
  expect(githubLinks.pullRequest(GITHUB_WEB, repo, 148)).toBe("https://github.com/sam/app/pull/148");
  expect(githubLinks.pullRequest(DEMO_API.github, repo, 148)).toBe("/api/v1/demo/github/sam/app/pull/148");
});

test("an installation on an organisation links to the organisation's settings", () => {
  const acme = { id: 9, login: "acme", type: "Organization" } as const;
  expect(githubLinks.installation(GITHUB_WEB, acme, 77)).toBe(
    "https://github.com/organizations/acme/settings/installations/77",
  );
  expect(githubLinks.installation(DEMO_API.github, acme, 77)).toBe(
    "/api/v1/demo/github/organizations/acme/settings/installations/77",
  );
  expect(githubLinks.install(GITHUB_WEB, "lookover-k3x9q2")).toBe(
    "https://github.com/apps/lookover-k3x9q2/installations/new",
  );
});

test("an organisation's owners: its people page, filtered to owners, on the web address the service gives", () => {
  expect(githubLinks.owners(GITHUB_WEB, "ledger-dev")).toBe(
    "https://github.com/orgs/ledger-dev/people?query=role%3Aowner",
  );
  expect(githubLinks.owners(DEMO_API.github, "ledger-dev")).toBe(
    "/api/v1/demo/github/orgs/ledger-dev/people?query=role%3Aowner",
  );
});

test("a refusal gives the connection the cause the adapter named, else unreachable or signed out; others cut nothing", () => {
  const suspended = { kind: "uninstalled", suspended: true } as const;
  expect(connectionCauseOf(new HostError("unauthorized", "x", { connectionCause: suspended }))).toEqual(
    suspended,
  );
  expect(connectionCauseOf(new HostError("unavailable", "x"))).toEqual({ kind: "unreachable" });
  expect(connectionCauseOf(new HostError("unauthorized", "x"))).toEqual({ kind: "signed-out" });
  expect(connectionCauseOf(new HostError("rate_limited", "x"))).toBeNull();
  expect(connectionCauseOf(new HostError("not_found", "x"))).toBeNull();
});
