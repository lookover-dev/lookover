// A panel's error stays in its panel (ADR 0085, design-system.md "Failed panel"): each screen, setup, each overlay and
// the whole app render inside a `Boundary`. When what it holds throws, that place alone says what couldn't be shown and
// offers a reload; the error goes to the console. A boundary keyed by what it shows (a path, an opening) starts over
// when that changes.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { FAILED_PILL, type FailedPlace, failedLine, RELOAD } from "../view-model/failed.ts";
import { Button } from "./basics.tsx";

const reload = () => location.reload();

/**
 * How a failed place shows. `panel`, in the flow where it stood; `whole`, alone in the middle of the window (the root,
 * setup); `pill`, the status pill's own box with its dot pink, in the anchor the pill stands in, so the top bar keeps
 * its size and the pill its place at the right.
 */
export type FailedLook = "panel" | "whole" | "pill";

/** What a failed place shows in its stead, as `look` says. */
export function Failed({ what, look = "panel" }: { what: FailedPlace; look?: FailedLook }) {
  if (look === "pill") {
    return (
      <div className="anchor">
        <button type="button" className="pill" aria-label={`${failedLine(what)} ${RELOAD}`} onClick={reload}>
          <i className="need" />
          {FAILED_PILL}
        </button>
      </div>
    );
  }
  return (
    <div className={look === "whole" ? "failed whole" : "failed"} role="alert">
      <span>{failedLine(what)}</span>
      <Button size="sm" onClick={reload}>
        {RELOAD}
      </Button>
    </div>
  );
}

interface BoundaryProps {
  what: FailedPlace;
  look?: FailedLook;
  /** Where the failed line goes when the place is an overlay of its own (the palette's dialog); in place otherwise. */
  frame?: (failed: ReactNode) => ReactNode;
  children: ReactNode;
}

/** An error boundary: what it holds, or, once that threw, `Failed` in its place, until it is mounted again. */
export class Boundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(failedLine(this.props.what), error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const failed = <Failed what={this.props.what} look={this.props.look ?? "panel"} />;
    return this.props.frame ? this.props.frame(failed) : failed;
  }
}
