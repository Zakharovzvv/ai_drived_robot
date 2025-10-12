import { useMemo } from "react";
import { useOperator } from "../state/OperatorProvider.jsx";

function computeStatus(headerStatus) {
  const classNames = ["status-indicator"];
  let text = "Connecting...";

  if (!headerStatus) {
    classNames.push("connecting");
    return { className: classNames.join(" "), text };
  }

  const { phase, robotConnected, medium, ip, stale } = headerStatus;

  if (phase === "disconnected") {
    classNames.push("disconnected");
    text = "Server Link Lost";
  } else if (!robotConnected) {
    if (phase === "connecting") {
      classNames.push("connecting");
      text = "Connecting...";
    } else {
      classNames.push("disconnected");
      text = "Robot Offline";
    }
  } else if (stale) {
    classNames.push("warn");
    text = "Robot Status Stale";
  } else {
    classNames.push("connected");
    if (medium === "wifi") {
      text = `Robot Online • Wi-Fi${ip ? ` (${ip})` : ""}`;
    } else if (medium === "type-c") {
      text = "Robot Online • Type-C";
    } else {
      text = "Robot Online";
    }
  }

  return { className: classNames.join(" "), text };
}

export default function Header() {
  const { headerStatus } = useOperator();
  const status = useMemo(() => computeStatus(headerStatus), [headerStatus]);

  return (
    <header className="header-compact">
      <div className="header-content">
        <h1>RBM Operator Console</h1>
        <div className="connection-status">
          <span className={status.className} aria-live="polite">
            <span className="status-dot" role="img" aria-label="Connection status" />
            <span className="status-text">{status.text}</span>
          </span>
        </div>
      </div>
    </header>
  );
}
