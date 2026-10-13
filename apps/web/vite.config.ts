import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The dev launcher (scripts/dev.ts) picks the port per worktree and passes it in LOOKOVER_UI_PORT. In service
// mode it also passes the service's origin in LOOKOVER_API: `/api` is proxied there, so the app and the service
// share one origin (the cookie, the Origin and Host checks, no CORS: ADR 0010).
const api = process.env.LOOKOVER_API;

/**
 * The program's build (`build:program`, ADR 0054) says so: `lookover-program.json` beside `index.html`, so whoever
 * serves the folder can tell it from a demo or live build. Any other build leaves none, and empties the folder first.
 */
function programMarker(): Plugin {
  return {
    name: "lookover-program-marker",
    apply: "build",
    generateBundle() {
      if (process.env.VITE_LOOKOVER_MODE !== "program") return;
      this.emitFile({
        type: "asset",
        fileName: "lookover-program.json",
        source: `${JSON.stringify({ mode: "program" })}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), programMarker()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.LOOKOVER_UI_PORT ?? 5173),
    strictPort: true,
    ...(api ? { proxy: { "/api": { target: api } } } : {}),
  },
});
