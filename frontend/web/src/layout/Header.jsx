import { useCallback, useMemo } from "react";
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
  const { headerStatus, controlState, controlModePending, changeControlTransport } = useOperator();
  const status = useMemo(() => computeStatus(headerStatus), [headerStatus]);
  const transports = controlState?.transports ?? [];
  const activeMode = controlState?.mode ?? "auto";

  const selectorOptions = useMemo(() => {
    const options = [
      { value: "auto", label: "Auto (Wi-Fi -> UART)" },
      ...transports.map((transport) => ({
        value: transport.id,
        label: `${transport.label || transport.id.toUpperCase()}${transport.available ? "" : " (offline)"}`,
      })),
    ];
    return options;
  }, [transports]);

  const handleModeChange = useCallback(
    (event) => {
      const value = event.target.value;
      changeControlTransport(value).catch(() => {});
    },
    [changeControlTransport]
  );

  return (
    <header className="header-compact">
      <div className="header-content">
        <h1>RBM Operator Console</h1>
        <div className="connection-status">
          <span className={`${status.className} status-with-select`} aria-live="polite">
            <span className="status-dot" role="img" aria-label="Connection status" />
            <div className="status-content">
              <span className="sr-only">{status.text}</span>
              <div className="status-control">
                <span className="status-control-label">Control:</span>
                <label className="sr-only" htmlFor="control-transport-select">
                  Select control transport
                </label>
                <select
                  id="control-transport-select"
                  value={activeMode}
                  onChange={handleModeChange}
                  disabled={controlModePending || selectorOptions.length <= 1}
                >
                  {selectorOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </span>
        </div>
      </div>
    </header>
  );
}
