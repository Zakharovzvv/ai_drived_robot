import { useEffect, useMemo } from "react";
import { useOperator } from "../state/OperatorProvider.jsx";

function buildBadge(cameraState) {
  if (!cameraState) {
    return {
      text: "Camera: --",
      className: "badge badge-muted",
      title: "No data",
    };
  }

  if (cameraState.error) {
    return {
      text: "Camera: Error",
      className: "badge badge-error",
      title: cameraState.error,
    };
  }

  const transport = (cameraState.transport || "unknown").toLowerCase();
  const streamingLabel =
    cameraState.streaming === true
      ? "Streaming"
      : cameraState.streaming === false
      ? "Idle"
      : "Unknown";
  const labelMap = {
    wifi: "Wi-Fi",
    "type-c": "Type-C",
    unconfigured: "Not Configured",
    unknown: "Unknown",
  };
  const transportLabel = labelMap[transport] || "Unknown";
  let badgeClass = "badge";
  switch (transport) {
    case "wifi":
      badgeClass += " badge-wifi";
      break;
    case "type-c":
      badgeClass += " badge-type-c";
      break;
    case "unconfigured":
      badgeClass += " badge-muted";
      break;
    default:
      badgeClass += " badge-unknown";
      break;
  }

  const sourceLabel = cameraState.source === "override" ? "Manual URL" : "Auto";
  const tooltipParts = [`Mode: ${sourceLabel}`];
  if (cameraState.snapshotUrl) {
    tooltipParts.push(`Snapshot: ${cameraState.snapshotUrl}`);
  }
  if (cameraState.streamIntervalMs) {
    tooltipParts.push(`Interval: ${cameraState.streamIntervalMs} ms`);
  }
  if (cameraState.resolution) {
    tooltipParts.push(`Resolution: ${cameraState.resolution}`);
  }
  if (cameraState.quality != null) {
    tooltipParts.push(`Quality: ${cameraState.quality}`);
  }

  return {
    text: `Camera: ${transportLabel} • ${streamingLabel}`,
    className: badgeClass,
    title: tooltipParts.join("\n"),
  };
}

function computeToggleState({ cameraState, cameraTogglePending }) {
  if (cameraState.source === "override") {
    return {
      label: "Manual URL Active",
      className: "btn-secondary btn-sm",
      disabled: true,
      title: "Streaming managed by manual override URL",
    };
  }

  if (cameraTogglePending) {
    const baseClass = cameraState.streaming ? "btn-danger" : "btn-primary";
    return {
      label: "Applying...",
      className: `${baseClass} btn-sm`,
      disabled: true,
      title: "Waiting for ESP32 response",
    };
  }

  if (cameraState.streaming === null) {
    return {
      label: "Stream Status...",
      className: "btn-secondary btn-sm",
      disabled: true,
      title: "Awaiting status update from ESP32",
    };
  }

  if (cameraState.streaming === true) {
    return {
      label: "Disable Stream",
      className: "btn-danger btn-sm",
      disabled: false,
      title: "Send CAMSTREAM OFF",
    };
  }

  return {
    label: "Enable Stream",
    className: "btn-primary btn-sm",
    disabled: false,
    title: "Send CAMSTREAM ON",
  };
}

export default function CameraPage() {
  const {
    cameraState,
    toggleCameraStreaming,
    cameraTogglePending,
    restartCameraStream,
    ensureCameraStream,
    disconnectCameraSocket,
  } = useOperator();

  useEffect(() => {
    ensureCameraStream();
    return () => {
      disconnectCameraSocket();
    };
  }, [ensureCameraStream, disconnectCameraSocket]);

  const badge = useMemo(() => buildBadge(cameraState), [cameraState]);
  const toggle = useMemo(
    () => computeToggleState({ cameraState, cameraTogglePending }),
    [cameraState, cameraTogglePending]
  );

  const placeholderMessage = cameraState.error
    ? cameraState.error
    : cameraState.streaming === false && cameraState.source !== "override"
    ? "Camera stream disabled. Use Enable Stream above."
    : "Camera feed unavailable";

  return (
    <section className="tab-content active" data-tab-content="camera">
      <div className="section-header">
        <h2>Camera Feed</h2>
        <div className="section-actions">
          <span className={badge.className} role="status" aria-live="polite" aria-atomic="true" title={badge.title}>
            {badge.text}
          </span>
          <button
            type="button"
            className={toggle.className}
            onClick={toggleCameraStreaming}
            disabled={toggle.disabled}
            title={toggle.title}
          >
            {toggle.label}
          </button>
          <button
            type="button"
            className="btn-icon"
            aria-label="Refresh camera"
            title="Refresh feed"
            onClick={() => restartCameraStream(true)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
          </button>
        </div>
      </div>
      <div className="camera-container-large">
        {cameraState.frame ? (
          <img src={cameraState.frame} alt="Robot camera feed" aria-live="polite" />
        ) : (
          <div className="camera-placeholder">
            <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            <p>{placeholderMessage}</p>
          </div>
        )}
      </div>
    </section>
  );
}
