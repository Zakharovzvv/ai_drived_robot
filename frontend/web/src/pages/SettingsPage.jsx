import { useCallback, useEffect, useMemo, useState } from "react";
import { useOperator } from "../state/OperatorProvider.jsx";
import { createEmptyShelfGrid, validateShelfGrid } from "../shelfMap.js";

const CONTROL_MODE_LABEL = {
  auto: "Auto (Wi-Fi -> UART)",
};

function resolveModeLabel(mode, transports) {
  if (!mode) {
    return CONTROL_MODE_LABEL.auto;
  }
  const normalized = mode.toString().trim().toLowerCase();
  if (normalized === "auto") {
    return CONTROL_MODE_LABEL.auto;
  }
  const match = transports.find((entry) => entry.id === normalized);
  if (match?.label) {
    return match.label;
  }
  return normalized.toUpperCase();
}

function formatTimestamp(value) {
  if (!value) {
    return "—";
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return `${parsed.toLocaleDateString()} ${parsed.toLocaleTimeString()}`;
    }
  }
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return "—";
  }
  const milliseconds = numeric > 1e12 ? numeric : numeric * 1000;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function ControlTransportSettings() {
  const { controlState, controlModePending, changeControlTransport, fetchControlState } = useOperator();
  const transports = controlState?.transports ?? [];
  const activeMode = controlState?.mode ?? "auto";
  const activeTransport = transports.find((entry) => entry.id === controlState?.active) || null;
  const preferredLabel = useMemo(() => resolveModeLabel(activeMode, transports), [activeMode, transports]);
  const autoBadgeClass = useMemo(() => {
    const classes = ["transport-badge"];
    if (activeMode === "auto") {
      classes.push("active");
    }
    return classes.join(" ");
  }, [activeMode]);

  const handleRefresh = useCallback(() => {
    fetchControlState({ silent: false }).catch(() => {});
  }, [fetchControlState]);

  const handleSwitch = useCallback(
    (target) => {
      changeControlTransport(target).catch(() => {});
    },
    [changeControlTransport]
  );

  return (
    <article className="settings-card" data-device="control-link">
      <header>
        <h3>Control Link</h3>
        <p>Manage Wi-Fi and UART command channels for the robot.</p>
      </header>
      <div className="transport-settings-summary">
        <div className="transport-summary-card">
          <span className="summary-label">Preferred Mode</span>
          <span className="summary-value">{preferredLabel}</span>
        </div>
        <div className="transport-summary-card">
          <span className="summary-label">Active Channel</span>
          <span className="summary-value">{activeTransport ? activeTransport.label : "Pending"}</span>
          {activeTransport?.endpoint ? (
            <span className="summary-subtle">{activeTransport.endpoint}</span>
          ) : null}
        </div>
        <div className="transport-summary-card summary-actions">
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={handleRefresh}
            disabled={controlModePending}
          >
            {controlModePending ? "Checking..." : "Refresh Status"}
          </button>
        </div>
      </div>
      <ul className="transport-status-list">
        <li className="transport-status-item" data-active={activeMode === "auto"}>
          <div className="transport-status-header">
            <div>
              <span className="transport-name">Automatic Selection</span>
              <span className={autoBadgeClass}>
                Prefers Wi-Fi, falls back to UART
              </span>
            </div>
            <div className="transport-actions">
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => handleSwitch("auto")}
                disabled={controlModePending || activeMode === "auto"}
              >
                {activeMode === "auto" ? "Selected" : "Use Auto"}
              </button>
            </div>
          </div>
          <div className="transport-meta">
            <span>Attempts Wi-Fi first, then retries via UART if needed.</span>
          </div>
        </li>
        {transports.map((transport) => {
          const meta = [];
          if (transport.endpoint) {
            meta.push(`Endpoint: ${transport.endpoint}`);
          }
          meta.push(`Last success: ${formatTimestamp(transport.last_success)}`);
          if (transport.last_failure) {
            meta.push(`Last failure: ${formatTimestamp(transport.last_failure)}`);
          }
          const classes = [
            "transport-badge",
            transport.available ? "online" : "offline",
            transport.id === activeTransport?.id ? "active" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li key={transport.id} className="transport-status-item" data-active={transport.id === activeTransport?.id}>
              <div className="transport-status-header">
                <div>
                  <span className="transport-name">{transport.label || transport.id.toUpperCase()}</span>
                  <span className={classes}>
                    <span className="badge-dot" />
                    {transport.available ? "Online" : "Unavailable"}
                  </span>
                </div>
                <div className="transport-actions">
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => handleSwitch(transport.id)}
                    disabled={controlModePending || activeMode === transport.id}
                  >
                    {activeMode === transport.id ? "Selected" : `Use ${transport.label || transport.id.toUpperCase()}`}
                  </button>
                </div>
              </div>
              <div className="transport-meta">
                {meta.map((entry) => (
                  <span key={entry}>{entry}</span>
                ))}
              </div>
            </li>
          );
        })}
        {transports.length === 0 ? (
          <li className="transport-status-item empty">Transport details are not available yet.</li>
        ) : null}
      </ul>
      <p className="transport-settings-hint">
        Switch the preferred transport from the header or by using the buttons above. Manual overrides trigger a
        new health check immediately.
      </p>
    </article>
  );
}

function CameraSettings() {
  const {
    cameraConfig,
    cameraConfigStatus,
    cameraConfigLoading,
    cameraConfigUpdating,
    loadCameraConfig,
    applyCameraConfig,
  } = useOperator();
  const [resolution, setResolution] = useState(cameraConfig?.resolution || "");
  const [quality, setQuality] = useState(
    cameraConfig?.quality ?? cameraConfig?.quality_min ?? 10
  );

  useEffect(() => {
    loadCameraConfig({ silent: Boolean(cameraConfig) }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!cameraConfig) return;
    setResolution(cameraConfig.resolution);
    const fallback = cameraConfig.quality ?? cameraConfig.quality_min ?? 10;
    setQuality(fallback);
  }, [cameraConfig]);

  const options = useMemo(() => {
    if (!cameraConfig?.available_resolutions?.length) {
      return [];
    }
    return cameraConfig.available_resolutions.map((item) => {
      const value = (item.id || item.value || item.label || "").toString().toUpperCase();
      const width = item.width ? `${item.width}` : null;
      const height = item.height ? `${item.height}` : null;
      const label = item.label || value;
      const dimensions = width && height ? `${width}×${height}` : null;
      return {
        value,
        label: dimensions ? `${label} (${dimensions})` : label,
        unsupported: item.supported === false,
      };
    });
  }, [cameraConfig]);

  const qualityMin = cameraConfig?.quality_min ?? 10;
  const qualityMax = cameraConfig?.quality_max ?? 63;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!cameraConfig) {
      loadCameraConfig({ silent: false }).catch(() => {});
      return;
    }
    const changes = {};
    if (resolution && resolution !== cameraConfig.resolution) {
      changes.resolution = resolution;
    }
    const numericQuality = Number.parseInt(quality, 10);
    if (!Number.isNaN(numericQuality) && numericQuality !== cameraConfig.quality) {
      changes.quality = numericQuality;
    }
    try {
      await applyCameraConfig(changes);
    } catch {
      // handled by provider
    }
  };

  return (
    <article className="settings-card" data-device="camera">
      <header>
        <h3>Camera</h3>
        <p>Adjust video quality and resolution.</p>
      </header>
      <form className="settings-form" onSubmit={handleSubmit}>
        <div className="settings-field">
          <label htmlFor="camera-settings-resolution">Resolution</label>
          <select
            id="camera-settings-resolution"
            name="resolution"
            value={resolution}
            onChange={(event) => setResolution(event.target.value.toUpperCase())}
            disabled={cameraConfigLoading || cameraConfigUpdating}
            aria-label="Camera resolution"
          >
            {options.map((option) => (
              <option
                key={option.value}
                value={option.value}
                data-unsupported={option.unsupported ? "true" : "false"}
                title={option.unsupported ? "Robot currently reports this level as unsupported" : undefined}
              >
                {option.label}
                {option.unsupported ? " • unsupported" : ""}
              </option>
            ))}
            {cameraConfig &&
              resolution &&
              !options.some((option) => option.value === resolution) && (
                <option value={resolution}>{`${resolution} (current)`}</option>
              )}
          </select>
          {cameraConfig?.max_resolution ? (
            <p className="settings-hint" role="note">
              Firmware reports maximum supported resolution: {cameraConfig.max_resolution}
            </p>
          ) : null}
          <label htmlFor="camera-settings-quality">
            JPEG Quality <span>{Number.isFinite(Number(quality)) ? quality : "—"}</span>
          </label>
          <input
            id="camera-settings-quality"
            name="quality"
            type="range"
            min={qualityMin}
            max={qualityMax}
            step="1"
            value={quality}
            onChange={(event) => setQuality(event.target.value)}
            disabled={cameraConfigLoading || cameraConfigUpdating}
          />
          <p className="settings-hint">
            Lower numbers increase compression (faster), higher numbers improve detail.
          </p>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => loadCameraConfig({ silent: false }).catch(() => {})}
            disabled={cameraConfigLoading || cameraConfigUpdating}
          >
            Refresh
          </button>
          <button type="submit" className="btn-primary btn-sm" disabled={cameraConfigUpdating}>
            {cameraConfigUpdating ? "Applying..." : "Apply Changes"}
          </button>
        </div>
        {cameraConfigStatus?.message ? (
          <p
            className={`settings-status ${cameraConfigStatus.tone === "success" ? "success" : cameraConfigStatus.tone === "error" ? "error" : ""}`.trim()}
            role="status"
            aria-live="polite"
          >
            {cameraConfigStatus.message}
          </p>
        ) : null}
      </form>
    </article>
  );
}

function ShelfMapSettings() {
  const {
    shelfMapState,
    shelfPalette,
    shelfStatus,
    shelfBusy,
    reloadShelfMap,
    updateShelfMap,
    resetShelfMap,
    confirm,
  } = useOperator();

  const [grid, setGrid] = useState(shelfMapState?.grid || createEmptyShelfGrid());
  const [persist, setPersist] = useState(false);

  useEffect(() => {
    reloadShelfMap({ silent: Boolean(shelfMapState) }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (shelfMapState?.grid) {
      setGrid(shelfMapState.grid);
    }
  }, [shelfMapState]);

  const handleSelect = (row, col, value) => {
    setGrid((prev) => {
      const next = prev.map((r) => [...r]);
      next[row][col] = value;
      return next;
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    try {
      const normalized = validateShelfGrid(grid, shelfPalette.map((entry) => entry.id));
      await updateShelfMap({ grid: normalized, persist });
    } catch {
      // handled by provider
    }
  };

  const handleReload = () => {
    reloadShelfMap({ silent: false }).catch(() => {});
  };

  const handleReset = async () => {
    const confirmed = await confirm(
      "Reset Shelf Map",
      "Restore the default color layout on the robot? Current assignments will be lost."
    );
    if (!confirmed) return;
    try {
      await resetShelfMap({ persist });
    } catch {
      // handled by provider
    }
  };

  return (
    <article className="settings-card" data-device="shelf-map">
      <header>
        <h3>Shelf Map</h3>
        <p>Assign colors to the 3×3 storage grid used by the picker.</p>
      </header>
      <form className="settings-form" onSubmit={handleSubmit}>
        <div className="settings-field">
          <label htmlFor="shelf-map-grid">Slots</label>
          <div id="shelf-map-grid" className="shelf-map-grid" role="grid" aria-label="Shelf map grid">
            {grid.map((row, rowIndex) =>
              row.map((cell, colIndex) => {
                const entry = shelfPalette.find((item) => item.id === cell);
                const style = entry
                  ? {
                      "--cell-color": entry.color,
                      "--cell-text-color": entry.textColor,
                    }
                  : undefined;
                return (
                  <select
                    key={`${rowIndex}-${colIndex}`}
                    className="shelf-map-select"
                    style={style}
                    value={cell}
                    onChange={(event) => handleSelect(rowIndex, colIndex, event.target.value.toUpperCase())}
                    disabled={shelfBusy}
                    aria-label={`Row ${rowIndex + 1}, Column ${colIndex + 1}`}
                  >
                    {shelfPalette.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                );
              })
            )}
          </div>
        </div>
        <div className="settings-field checkbox-field">
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={persist}
              onChange={(event) => setPersist(event.target.checked)}
              disabled={shelfBusy}
            />
            <span>Save to flash (NVS) after applying</span>
          </label>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={handleReload}
            disabled={shelfBusy}
          >
            Reload
          </button>
          <button
            type="button"
            className="btn-danger btn-sm"
            onClick={handleReset}
            disabled={shelfBusy}
          >
            Reset to Default
          </button>
          <button type="submit" className="btn-primary btn-sm" disabled={shelfBusy}>
            {shelfBusy ? "Working..." : "Apply Changes"}
          </button>
        </div>
        {shelfStatus?.message ? (
          <p
            className={`settings-status ${shelfStatus.tone === "success" ? "success" : shelfStatus.tone === "error" ? "error" : ""}`.trim()}
            role="status"
            aria-live="polite"
          >
            {shelfStatus.message}
          </p>
        ) : null}
      </form>
    </article>
  );
}

export default function SettingsPage() {
  return (
    <section className="tab-content active" data-tab-content="settings">
      <div className="section-header">
        <h2>System Settings</h2>
      </div>
      <div className="settings-grid">
        <ControlTransportSettings />
        <CameraSettings />
        <ShelfMapSettings />
        <article className="settings-card" data-device="esp32">
          <header>
            <h3>ESP32 Controller</h3>
            <p>Network and system options (coming soon).</p>
          </header>
          <div className="settings-placeholder">
            <p>Additional ESP32 settings will appear here.</p>
          </div>
        </article>
        <article className="settings-card" data-device="uno">
          <header>
            <h3>UNO Controller</h3>
            <p>Calibration and motion parameters.</p>
          </header>
          <div className="settings-placeholder">
            <p>Connect the UNO to adjust line sensor thresholds and drivetrain configs.</p>
          </div>
        </article>
      </div>
    </section>
  );
}
