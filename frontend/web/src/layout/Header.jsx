import { useCallback, useMemo } from "react";
import { useOperator } from "../state/OperatorProvider.jsx";

function extractEndpointHost(endpoint) {
  if (!endpoint || typeof endpoint !== "string") {
    return "";
  }
  const match = endpoint.match(/^[a-z]+:\/\/([^/]+)/i);
  if (match && match[1]) {
    return match[1];
  }
  if (endpoint.startsWith("//")) {
    return endpoint.slice(2).split("/")[0] || "";
  }
  return endpoint.split("/")[0];
}

function formatTransportLabel(transport, summary) {
  if (!transport) {
    if (summary?.transportLabel) {
      return summary.transportLabel;
    }
    if (summary?.transportId) {
      return summary.transportId.toUpperCase();
    }
    return "Control Link";
  }

  const endpoint = transport.endpoint || summary?.endpoint || "";
  const host = extractEndpointHost(endpoint);

  if (transport.id === "wifi") {
    return `Wi-Fi${host ? ` (${host})` : ""}`;
  }
  if (transport.id === "serial") {
    return host ? `UART (${host})` : "UART";
  }
  return transport.label || (transport.id ? transport.id.toUpperCase() : "Control Link");
}

function computeStatus(headerStatus, controlOverview) {
  const classNames = ["status-indicator"];
  let text = "Connecting...";

  const summary = controlOverview?.summary;
  const phase = summary?.phase ?? headerStatus?.phase ?? "connecting";

  if (phase === "disconnected") {
    classNames.push("disconnected");
    return { className: classNames.join(" "), text: "Server Link Lost" };
  }

  const primaryTransport = controlOverview?.primaryTransport || controlOverview?.activeTransport || null;

  if (summary?.status === "online" && primaryTransport) {
    const label = formatTransportLabel(primaryTransport, summary);
    if (summary?.stale) {
      classNames.push("warn");
      text = `Robot Online • ${label} (status stale)`;
    } else {
      classNames.push("connected");
      text = `Robot Online • ${label}`;
    }
    return { className: classNames.join(" "), text };
  }

  if (summary?.status === "connecting" || phase === "connecting") {
    classNames.push("connecting");
    return { className: classNames.join(" "), text };
  }

  if (headerStatus?.robotConnected) {
    const medium = headerStatus.medium;
    const label =
      medium === "wifi"
        ? `Wi-Fi${headerStatus.ip ? ` (${headerStatus.ip})` : ""}`
        : medium === "type-c"
        ? "UART"
        : "Control Link";
    const stale = headerStatus.stale;
    classNames.push(stale ? "warn" : "connected");
    text = `Robot Online • ${label}${stale ? " (status stale)" : ""}`;
    return { className: classNames.join(" "), text };
  }

  classNames.push("disconnected");
  return { className: classNames.join(" "), text: "Robot Offline" };
}

export default function Header() {
  const { headerStatus, controlOverview, controlState, controlModePending, changeControlTransport } = useOperator();
  const status = useMemo(() => computeStatus(headerStatus, controlOverview), [headerStatus, controlOverview]);
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
