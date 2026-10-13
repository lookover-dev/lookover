// The owner's App and its installation (ADR 0053): the links to GitHub's pages, built on the connection's web
// address, and the cause a host's refusal gives the connection.
import { expect, test } from "bun:test";
import {
  APP_PERMISSIONS,
  connectionCauseOf,
  DEMO_API,
  GITHUB_WEB,
  githubLinks,
  HostError,
  PRIVATE_KEY_ARMOUR,
} from "./index.ts";

test("a private key's armour is found whatever its kind, and only a private key's", () => {
  for (const kind of ["RSA ", "", "EC ", "ENCRYPTED ", "OPENSSH ", "DSA "])
    expect(PRIVATE_KEY_ARMOUR.test(`x\n-----BEGIN ${kind}PRIVATE KEY-----\nabc`)).toBe(true);
  for (const text of [
    "-----BEGIN PUBLIC KEY-----",
    "-----BEGIN CERTIFICATE-----",
    "BEGIN RSA PRIVATE KEY",
    "",
  ])
    expect(PRIVATE_KEY_ARMOUR.test(text)).toBe(false);
});

const SAM = { id: 7, login: "sam", type: "User" } as const;

test("every link to GitHub is built on the web address the service gives, GitHub's or demo mode's fake", () => {
  const repo = { owner: "sam", name: "app" };
  expect(githubLinks.install(GITHUB_WEB, "lookover-k3x9q2")).toBe(
    "https://github.com/apps/lookover-k3x9q2/installations/new",
  );
  expect(githubLinks.installation(GITHUB_WEB, SAM, 77)).toBe("https://github.com/settings/installations/77");
  expect(githubLinks.app(GITHUB_WEB, SAM, "lookover-k3x9q2")).toBe(
    "https://github.com/settings/apps/lookover-k3x9q2",
  );
  expect(githubLinks.newApp(GITHUB_WEB, null, "a b&c")).toBe(
    "https://github.com/settings/apps/new?state=a%20b%26c",
  );
  expect(githubLinks.pullRequest(GITHUB_WEB, repo, 148)).toBe("https://github.com/sam/app/pull/148");
  expect(githubLinks.pullRequest(DEMO_API.github, repo, 148)).toBe("/api/v1/demo/github/sam/app/pull/148");
});

test("an organisation's App links to the organisation's pages: its installation's settings and the App's", () => {
  const acme = { id: 9, login: "acme", type: "Organization" } as const;
  expect(githubLinks.installation(GITHUB_WEB, acme, 77)).toBe(
    "https://github.com/organizations/acme/settings/installations/77",
  );
  expect(githubLinks.app(GITHUB_WEB, acme, "lookover-k3x9q2")).toBe(
    "https://github.com/organizations/acme/settings/apps/lookover-k3x9q2",
  );
  expect(githubLinks.app(DEMO_API.github, acme, "lookover-k3x9q2")).toBe(
    "/api/v1/demo/github/organizations/acme/settings/apps/lookover-k3x9q2",
  );
  expect(githubLinks.install(GITHUB_WEB, "lookover-k3x9q2")).toBe(
    "https://github.com/apps/lookover-k3x9q2/installations/new",
  );
  expect(githubLinks.newApp(GITHUB_WEB, "lookover-dev", "a b&c")).toBe(
    "https://github.com/organizations/lookover-dev/settings/apps/new?state=a%20b%26c",
  );
});

test("a refusal gives the connection the cause the adapter named, else unreachable or a key refused; others cut nothing", () => {
  const suspended = { kind: "uninstalled", suspended: true } as const;
  expect(connectionCauseOf(new HostError("unauthorized", "x", { connectionCause: suspended }))).toEqual(
    suspended,
  );
  expect(connectionCauseOf(new HostError("unavailable", "x"))).toEqual({ kind: "unreachable" });
  expect(connectionCauseOf(new HostError("unauthorized", "x"))).toEqual({ kind: "key-refused", why: null });
  expect(connectionCauseOf(new HostError("rate_limited", "x"))).toBeNull();
  expect(connectionCauseOf(new HostError("not_found", "x"))).toBeNull();
});

test("the App asks for exactly ADR 0022's five permissions, and no Contents: write", () => {
  expect(APP_PERMISSIONS).toEqual({
    metadata: "read",
    contents: "read",
    pull_requests: "write",
    checks: "write",
    issues: "write",
  });
});
