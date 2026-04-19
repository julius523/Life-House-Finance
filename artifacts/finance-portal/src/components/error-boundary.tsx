// Task #60 — panel-level error boundary so a crash inside one card does
// not white-screen the whole page. Each Reports panel is wrapped in this
// boundary; a render error renders an inline message and leaves the rest
// of the page interactive.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the browser console so devs can still find the stack.
    // eslint-disable-next-line no-console
    console.error(`[PanelErrorBoundary:${this.props.label}]`, error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid={`panel-error-${this.props.label.replace(/\s+/g, "-").toLowerCase()}`}
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">
              {this.props.label} could not be displayed
            </div>
            <div className="text-muted-foreground">
              {this.state.error.message ||
                "An unexpected error occurred while rendering this panel."}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
