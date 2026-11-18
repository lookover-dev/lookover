// Settings' "Show Lookover in the tray" (ADR 0105 §11-13): the row beside Start at login, its switch the choice the
// store keeps (`service.tray`, saved through the page's stamp as Start at login's is), its help what the computer
// shows. The row is rendered to markup; the switch's wiring is read from the row's elements.
import { expect, test } from "bun:test";
import type { Command, Service, ServiceOs, TrayShown } from "@lookover/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { Switch } from "../ui/basics.tsx";
import { app, elements, screen, world } from "./repositories.test-support.tsx";
import { Settings, TrayRow } from "./settings.tsx";

const service = (os: ServiceOs, shown: TrayShown, reason: string | null = null): Service => ({
  ...world().service,
  os,
  tray: { on: shown !== "off", shown, reason },
});

const row = (s: Service, save: (c: Command) => void = () => undefined) => TrayRow({ service: s, save });

/** The row's switch, as its elements hold it. */
function switchOf(s: Service, save: (c: Command) => void = () => undefined) {
  const [control] = elements(row(s, save)).filter((e) => e.type === Switch);
  if (control === undefined) throw new Error("the row has no switch");
  return control;
}

test("the row sits right after Start at login, its own place to link to", () => {
  const html = screen(app(), world(), () => <Settings />);
  const login = html.indexOf('id="login"');
  const tray = html.indexOf('id="tray"');
  expect(login).toBeGreaterThan(-1);
  expect(tray).toBeGreaterThan(login);
  expect(html.indexOf('id="appearance"')).toBeGreaterThan(tray);
  expect(html).toContain("Show Lookover in the tray");
});

test("the switch is the choice: on while shown, starting or unavailable, off when chosen off", () => {
  expect(switchOf(service("windows", "shown")).props.checked).toBe(true);
  expect(switchOf(service("windows", "starting")).props.checked).toBe(true);
  expect(switchOf(service("windows", "unavailable", "No tray to show an icon in")).props.checked).toBe(true);
  expect(switchOf(service("windows", "off")).props.checked).toBe(false);
  expect(switchOf(service("windows", "off")).props.label).toBe("Show Lookover in the tray");
});

test("the switch sends the choice to the service, through the page's save", () => {
  const sent: Command[] = [];
  const turn = (s: Service, on: boolean) => {
    const onChange = switchOf(s, (c) => sent.push(c)).props.onChange;
    if (typeof onChange !== "function") throw new Error("the switch has no onChange");
    onChange(on);
  };
  turn(service("windows", "shown"), false);
  turn(service("windows", "off"), true);
  expect(sent).toEqual([
    { type: "service.tray", on: false },
    { type: "service.tray", on: true },
  ]);
});

test("the help says what the computer shows, and on Windows, in every state, where the icon sits", () => {
  const html = (s: Service) => renderToStaticMarkup(row(s));
  const find = "under the taskbar&#x27;s ^";
  expect(html(service("windows", "shown"))).toContain("On: its icon is in the tray.");
  expect(html(service("windows", "shown"))).toContain(find);
  // Off and unavailable say it too: switching the row changes only its On/Off clause, nothing under it moves.
  expect(html(service("windows", "off"))).toContain("Off: no icon is shown.");
  expect(html(service("windows", "off"))).toContain(find);
  const unavailable = html(service("windows", "unavailable", "No tray to show an icon in"));
  expect(unavailable).toContain("On, but its icon can&#x27;t be shown. No tray to show an icon in.");
  expect(unavailable).toContain(find);
  expect(html(service("macos", "shown"))).toContain("On: its icon is in the menu bar.");
  expect(html(service("linux", "shown"))).not.toContain("^");
});
