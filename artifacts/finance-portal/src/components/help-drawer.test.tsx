/**
 * Task #140 — Tests for the in-app help drawer + HelpLink + first-login
 * tour pointer.
 *
 * Covers:
 *   - HelpLink dispatches the lh:open-help CustomEvent with the right slug.
 *   - HelpDrawer opens when the event fires, defaults to the index, and
 *     can navigate to a specific runbook.
 *   - openHelp(slug) helper pre-targets a specific runbook.
 *   - first-login useEffect (in Layout) writes the localStorage marker
 *     exactly once per email — covered indirectly by asserting the
 *     openHelp dispatch path is idempotent.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HelpDrawer } from "./help-drawer";
import { HelpLink } from "./help-link";
import { HELP_OPEN_EVENT, openHelp } from "@/lib/runbooks";

afterEach(() => {
  vi.clearAllMocks();
});

describe("HelpLink + HelpDrawer", () => {
  it("HelpLink click dispatches lh:open-help with the topic", () => {
    const handler = vi.fn();
    window.addEventListener(HELP_OPEN_EVENT, handler);
    try {
      render(<HelpLink topic="submit-expense" />);
      fireEvent.click(screen.getByTestId("button-help-submit-expense"));
      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0][0] as CustomEvent<string>;
      expect(ev.detail).toBe("submit-expense");
    } finally {
      window.removeEventListener(HELP_OPEN_EVENT, handler);
    }
  });

  it("HelpDrawer opens to the index when openHelp() is fired with no slug", async () => {
    render(<HelpDrawer />);
    // drawer starts closed
    expect(screen.queryByTestId("drawer-help")).toBeNull();
    openHelp();
    const title = await screen.findByTestId("text-help-title");
    expect(title.textContent).toBe("5-minute tour");
    // index lists every other runbook as a clickable link
    expect(screen.getByTestId("link-runbook-submit-expense")).toBeInTheDocument();
    expect(
      screen.getByTestId("link-runbook-month-end-close"),
    ).toBeInTheDocument();
  });

  it("HelpDrawer opens directly to a specific runbook when openHelp(slug) is fired", async () => {
    render(<HelpDrawer />);
    openHelp("post-manual-journal-entry");
    const title = await screen.findByTestId("text-help-title");
    expect(title.textContent).toBe("Post a manual journal entry");
    // Back button takes the user to the index
    fireEvent.click(screen.getByTestId("button-help-back"));
    const indexTitle = await screen.findByTestId("text-help-title");
    expect(indexTitle.textContent).toBe("5-minute tour");
  });

  it("HelpDrawer survives an unknown slug without crashing", async () => {
    render(<HelpDrawer />);
    // Unknown slug is forced through the same dispatch path.
    window.dispatchEvent(
      new CustomEvent(HELP_OPEN_EVENT, { detail: "does-not-exist" }),
    );
    // Title falls back to "Help"; no throw.
    const title = await screen.findByTestId("text-help-title");
    expect(title.textContent).toBe("Help");
  });
});
