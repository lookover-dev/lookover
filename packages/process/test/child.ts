// The child program of the `process` tests: a small tree to time out, kill and sweep. Run with bun:
//   child.ts echo <code>                   upper-cases its stdin to stdout, writes "err" to stderr, exits <code>
//   child.ts linger <dir> <n> <tickMs>     spawns <n> grandchildren that linger, prints "pid <p>" for each,
//                                          writes <dir>/ready, then stays alive, printing "tick" every <tickMs>
//                                          ms (never when 0)
//   child.ts leave <dir> <n>               spawns <n> lingering grandchildren, prints their pids, exits 0 at once
// Grandchildren inherit stdout, so they keep the pipe open after the child is gone.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, ...rest] = process.argv.slice(2);

function grandchildren(n: number): number[] {
  const pids: number[] = [];
  for (let i = 0; i < n; i++) {
    const g = spawn(process.execPath, [process.argv[1] ?? "", "linger", "", "0", "0"], { stdio: "inherit" });
    if (g.pid !== undefined) pids.push(g.pid);
  }
  return pids;
}

function announce(pids: number[]) {
  for (const pid of pids) process.stdout.write(`pid ${pid}\n`);
}

if (mode === "echo") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    process.stdout.write(input.toUpperCase());
    process.stderr.write("err");
    process.exit(Number(rest[0] ?? "0"));
  });
} else if (mode === "linger") {
  const [dir, n, tickMs] = rest;
  announce(grandchildren(Number(n ?? "0")));
  if (dir) writeFileSync(join(dir, "ready"), "");
  const tick = Number(tickMs ?? "0");
  setInterval(
    () => {
      if (tick > 0) process.stdout.write("tick\n");
    },
    tick > 0 ? tick : 1000,
  );
} else if (mode === "leave") {
  const [dir, n] = rest;
  announce(grandchildren(Number(n ?? "0")));
  if (dir) writeFileSync(join(dir, "ready"), "");
  process.exit(0);
}
