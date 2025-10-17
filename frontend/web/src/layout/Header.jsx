import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();
  const { 
    headerStatus, 
    controlOverview, 
    controlState, 
    controlModePending, 
    changeControlTransport,
    startTask,
    executeRawCommand,
    brake,
    confirm
  } = useOperator();
  
  const status = useMemo(() => computeStatus(headerStatus, controlOverview), [headerStatus, controlOverview]);
  const transports = controlState?.transports ?? [];
  const activeMode = controlState?.mode ?? "auto";

  // Command bar state
  const [isCommandsExpanded, setIsCommandsExpanded] = useState(() => {
    const saved = localStorage.getItem("headerCommandsExpanded");
    if (saved !== null) {
      return saved === "true";
    }
    return window.innerWidth > 768;
  });
  
  const [taskId, setTaskId] = useState("default");
  const [command, setCommand] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isBraking, setIsBraking] = useState(false);

  // Save expanded state
  useEffect(() => {
    localStorage.setItem("headerCommandsExpanded", String(isCommandsExpanded));
  }, [isCommandsExpanded]);

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

  const handleStart = useCallback(
    async (event) => {
      event.preventDefault();
      if (isStarting) return;
      setIsStarting(true);
      try {
        await startTask(taskId.trim());
      } finally {
        setIsStarting(false);
      }
    },
    [isStarting, startTask, taskId]
  );

  const handleCommand = useCallback(
    async (event) => {
      event.preventDefault();
      if (isExecuting) return;
      const trimmed = command.trim();
      if (!trimmed) return;
      setIsExecuting(true);
      try {
        await executeRawCommand(trimmed);
      } finally {
        setIsExecuting(false);
        navigate("/output");
      }
    },
    [command, executeRawCommand, isExecuting, navigate]
  );

  const handleBrake = useCallback(async () => {
    if (isBraking) return;
    const confirmed = await confirm(
      "Emergency Stop",
      "This will immediately stop all actuators. Are you sure?"
    );
    if (!confirmed) return;
    setIsBraking(true);
    try {
      await brake();
    } finally {
      setIsBraking(false);
    }
  }, [brake, confirm, isBraking]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        handleBrake();
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        setIsCommandsExpanded((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleBrake]);

  return (
    <header className={`header-compact ${isCommandsExpanded ? 'header-expanded' : 'header-collapsed'}`}>
      <div className="header-content">
        <div className="header-main-row">
          <h1>RBM Operator Console</h1>
          
          <div className="header-actions">
            <button
              type="button"
              className="btn-header-toggle"
              onClick={() => setIsCommandsExpanded(!isCommandsExpanded)}
              title={isCommandsExpanded ? "Hide commands (Ctrl+Shift+C)" : "Show commands (Ctrl+Shift+C)"}
              aria-label={isCommandsExpanded ? "Hide commands" : "Show commands"}
              aria-expanded={isCommandsExpanded}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
              <span className="btn-text">Commands</span>
              <svg 
                width="16" 
                height="16" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2"
                className="chevron-icon"
              >
                {isCommandsExpanded ? (
                  <polyline points="18 15 12 9 6 15" />
                ) : (
                  <polyline points="6 9 12 15 18 9" />
                )}
              </svg>
            </button>

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
        </div>

        {isCommandsExpanded && (
          <div className="header-commands">
            <div className="command-group command-group-task">
              <label className="command-group-label">Task</label>
              <form className="inline-form" onSubmit={handleStart}>
                <input
                  name="task"
                  type="text"
                  value={taskId}
                  onChange={(event) => setTaskId(event.target.value)}
                  placeholder="default..."
                  aria-label="Task ID"
                  title="Task ID"
                />
                <button type="submit" className="btn-primary btn-action" disabled={isStarting} title="Start task">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  {isStarting ? "Starting…" : "Start"}
                </button>
              </form>
            </div>

            <div className="command-group command-group-emergency">
              <label className="command-group-label">Emergency</label>
              <button
                type="button"
                className="btn-danger btn-action"
                onClick={handleBrake}
                disabled={isBraking}
                title="Emergency stop (Ctrl+B)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <rect x="9" y="9" width="6" height="6" />
                </svg>
                {isBraking ? "Stopping…" : "BRAKE"}
              </button>
            </div>

            <div className="command-group command-group-debug">
              <label className="command-group-label">Command</label>
              <form className="inline-form command-input-group" onSubmit={handleCommand}>
                <input
                  name="command"
                  type="text"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="STATUS, CTRL..., CAMCFG..."
                  aria-label="CLI command"
                  title="Direct CLI command"
                />
                <button type="submit" className="btn-secondary btn-action" disabled={isExecuting} title="Send">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                  {isExecuting ? "Sending…" : "Send"}
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
