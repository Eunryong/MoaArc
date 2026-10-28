import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props { children: ReactNode; }
interface State { error: Error | null; info: string; }

/**
 * Top-level error boundary.
 * Catches any React render/lifecycle error and shows a visible fallback
 * instead of a silent white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, info: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error, info: "" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log without exposing tokens: strip Authorization header values from messages
    const safeMsg = error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    console.error("[ErrorBoundary]", safeMsg, info.componentStack?.slice(0, 300));
    this.setState({ info: info.componentStack?.slice(0, 400) ?? "" });
  }

  render() {
    if (this.state.error) {
      const safeMsg = this.state.error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
            fontFamily: "system-ui, sans-serif",
            background: "#fafaf9",
            color: "#1c1917",
          }}
        >
          <div
            style={{
              maxWidth: 520,
              background: "#fff",
              border: "1px solid #fca5a5",
              borderRadius: 12,
              padding: "2rem",
              boxShadow: "0 2px 12px rgba(0,0,0,.06)",
            }}
          >
            <h1 style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: "0.75rem", color: "#b91c1c" }}>
              앱 초기화 오류
            </h1>
            <p style={{ fontSize: "0.85rem", color: "#57534e", marginBottom: "1rem" }}>
              {safeMsg}
            </p>
            {this.state.info && (
              <details style={{ marginBottom: "1rem" }}>
                <summary style={{ fontSize: "0.75rem", cursor: "pointer", color: "#78716c" }}>컴포넌트 추적</summary>
                <pre style={{ fontSize: "0.7rem", overflow: "auto", marginTop: "0.5rem", color: "#57534e", whiteSpace: "pre-wrap" }}>
                  {this.state.info}
                </pre>
              </details>
            )}
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "0.5rem 1.25rem",
                background: "#4f46e5",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: "0.85rem",
                fontWeight: 600,
              }}
            >
              새로고침
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
