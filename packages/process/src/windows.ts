// Windows: a Job Object per started program, with kill-on-close, over `bun:ffi` to kernel32 (ADR 0012).
// Every process the program spawns joins the job (no breakaway is allowed), so terminating the job kills the
// whole tree, and the OS does the same by itself when the handle closes, Lookover's crash included. The job
// is nested when Lookover itself runs inside one (a terminal, Claude Code), which Windows allows since 8.
// The assignment comes right after spawn, so a grandchild started in that window (well under a millisecond)
// would escape; the programs run here take far longer to get there.
import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import type { Supervisor, Tree } from "./supervisor.ts";

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
// JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64 and arm64: 144 bytes, `LimitFlags` at byte 16.
const EXTENDED_LIMIT_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;

function loadKernel32() {
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

type Kernel32 = ReturnType<typeof loadKernel32>;
/** An OS handle as the FFI hands it back. */
type Handle = Pointer | bigint;

/** Runs `use` with a handle on the process, closed afterwards; null when no such process can be opened. */
function withProcess<T>(k: Kernel32, pid: number, access: number, use: (handle: Handle) => T): T | null {
  const handle = k.OpenProcess(access, 0, pid);
  if (handle === null) return null;
  try {
    return use(handle);
  } finally {
    k.CloseHandle(handle);
  }
}

function createJob(k: Kernel32): Handle | null {
  const job = k.CreateJobObjectW(null, null);
  if (job === null) return null;
  const info = new Uint8Array(EXTENDED_LIMIT_SIZE);
  new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (
    k.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(info), EXTENDED_LIMIT_SIZE) ===
    0
  ) {
    k.CloseHandle(job);
    return null;
  }
  return job;
}

function terminate(k: Kernel32, pid: number): void {
  withProcess(k, pid, PROCESS_TERMINATE, (handle) => k.TerminateProcess(handle, 1));
}

function contain(k: Kernel32, pid: number): Tree {
  // Without a job (out of handles, a job that forbids nesting) the root alone can be killed, never an
  // empty job: a kill that reaches nothing would let the tree outlive its limit.
  const rootOnly: Tree = { kill: () => terminate(k, pid), release: () => {} };
  const job = createJob(k);
  if (job === null) return rootOnly;
  const assigned = withProcess(k, pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE, (handle) =>
    k.AssignProcessToJobObject(job, handle),
  );
  if (assigned === null || assigned === 0) {
    k.CloseHandle(job);
    return rootOnly;
  }
  let released = false;
  return {
    kill: () => {
      if (!released) k.TerminateJobObject(job, 1);
    },
    release: () => {
      released = true;
      k.CloseHandle(job);
    },
  };
}

function creationTime(k: Kernel32, pid: number): string | null {
  return withProcess(k, pid, PROCESS_QUERY_LIMITED_INFORMATION, (handle) => {
    // A handle opens on a process that ended but is still referenced; its exit code tells.
    const exitCode = new Uint32Array(1);
    if (k.GetExitCodeProcess(handle, ptr(exitCode)) === 0 || exitCode[0] !== STILL_ACTIVE) return null;
    const times = new BigUint64Array(4);
    const at = (i: number) => ptr(times.buffer, i * 8);
    if (k.GetProcessTimes(handle, at(0), at(1), at(2), at(3)) === 0) return null;
    return String(times[0]);
  });
}

export function windowsSupervisor(): Supervisor {
  const k = loadKernel32();
  return {
    detached: false,
    contain: (pid) => contain(k, pid),
    creationTime: (pid) => creationTime(k, pid),
    // A previous run's job died with its handle, and the tree with it; only a root still here is terminated.
    killTree: (pid) => terminate(k, pid),
  };
}
