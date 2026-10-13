import "@fontsource-variable/figtree";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles/system.css";
import "./styles/app.css";
import "./styles/github.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { HttpApi } from "./api/http.ts";
import { App, type DevTools } from "./app.tsx";
import type { DemoApi } from "./dev/demo-api.ts";
import { modeOf, scenarioFromAddress } from "./dev/mode.ts";
import { applyTheme, Store } from "./store.tsx";

// The app runs on the service alone (ADR 0046), in the mode its build names (`dev/mode.ts`, ADR 0054): demo, live
// or the program. Each is served from the page's own origin (a dev server proxies `/api`, the program's service
// serves the page itself), so the session cookie goes along.
const mode = modeOf(import.meta.env.VITE_LOOKOVER_MODE);

// `?embed=1` is the phone preview's frame (`/phone`): the same page on the same service, without the drawer.
// `?scenario=S4` asks the demo driver to load that scenario once, before the app reads anything, and the
// address then drops the query so a reload keeps the story where it is.
const params = new URLSearchParams(location.search);
const embedded = params.has("embed");
const wanted = scenarioFromAddress(mode) && !embedded ? params.get("scenario") : null;

const http = new HttpApi();
applyTheme();

/** Loads the scenario the address names and moves to where it opens; a refusal keeps the one loaded, logged. */
async function loadWanted(demo: DemoApi, id: string): Promise<void> {
  try {
    await demo.send({ type: "demo.load", id });
    const listing = await demo.listing();
    const path = listing.scenarios.find((s) => s.id === id)?.path ?? "/";
    history.replaceState(null, "", location.pathname === "/" ? path : location.pathname);
  } catch (error) {
    // An unknown id (404), a load already under way (409), a tab without the session (401: the app's snapshot
    // says so next): the app opens on what the service holds.
    console.error(`Scenario ${id} could not be loaded`, error);
    history.replaceState(null, "", location.pathname);
  }
}

/**
 * The developer's tools, the scenario the address names loaded first; none in the program. Vite replaces the mode
 * with its literal, so the program's build drops this branch and, with it, the drawer and the demo client.
 */
async function developerTools(): Promise<DevTools | null> {
  if (import.meta.env.VITE_LOOKOVER_MODE === "program") return null;
  const [{ DemoApi }, { devTools }] = await Promise.all([
    import("./dev/demo-api.ts"),
    import("./dev/tools.tsx"),
  ]);
  const demo = new DemoApi({ lost: (open) => http.endSession(open) });
  if (wanted) await loadWanted(demo, wanted);
  return devTools(mode, demo);
}

async function start(): Promise<void> {
  const dev = await developerTools();
  const store = new Store(http);

  const root = document.getElementById("root");
  if (!root) throw new Error("index.html has no #root element");
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App store={store} embedded={embedded} dev={dev} mode={mode} />
      </BrowserRouter>
    </StrictMode>,
  );
}

void start();
