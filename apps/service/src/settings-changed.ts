// Windows' settings-change broadcast (`WM_SETTINGCHANGE` with "Environment"), over `bun:ffi` to user32's
// `SendMessageTimeoutW` (ADR 0058): what tells Explorer, and the terminals it opens next, that the user's environment
// changed. The call is synchronous and waits up to a second for each top-level window that doesn't answer, one after
// the other: seconds on a machine with a few hung windows. So it runs in a worker of its own, never on the service's
// thread, and nothing waits for it. Best effort: a broadcast that fails undoes nothing written. The worker is made from
// its source, not a file, so the compiled binary carries it with nothing to bundle (tried on Windows 11, #293).

/** What the worker runs: the broadcast, then whether it could, posted back. */
const BROADCAST = `
import { dlopen, FFIType, ptr } from "bun:ffi";
const HWND_BROADCAST = 0xffff;
const WM_SETTINGCHANGE = 0x001a;
const SMTO_ABORTIFHUNG = 0x0002;
const TIMEOUT_MS = 1000;
let sent = false;
try {
  const user32 = dlopen("user32.dll", {
    SendMessageTimeoutW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.ptr,
    },
  });
  try {
    const area = Buffer.from("Environment\\0", "utf16le");
    const result = new BigUint64Array(1);
    user32.symbols.SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, ptr(area), SMTO_ABORTIFHUNG, TIMEOUT_MS, ptr(result));
    sent = true;
  } finally {
    user32.close();
  }
} catch {}
postMessage(sent);
`;

/**
 * Tells every top-level window the environment changed, from a worker: settles with whether it could once every
 * window answered or timed out; false outside Windows. Never holds the process open, and callers needn't wait.
 */
export function settingsChanged(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((done) => {
    try {
      const worker = new Worker(URL.createObjectURL(new Blob([BROADCAST], { type: "text/javascript" })));
      // Bun's workers can be unreferenced; the DOM's type doesn't say so.
      if ("unref" in worker && typeof worker.unref === "function") worker.unref();
      const end = (sent: boolean) => {
        done(sent);
        worker.terminate();
      };
      worker.onmessage = (event) => end(event.data === true);
      worker.onerror = () => end(false);
    } catch {
      // Best effort: the value is written; Explorer and the terminals it opens see it after the next sign-in.
      done(false);
    }
  });
}
