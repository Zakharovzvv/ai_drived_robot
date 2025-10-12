import { useEffect, useMemo, useState } from "react";
import { useOperator } from "../state/OperatorProvider.jsx";
import { createEmptyShelfGrid, validateShelfGrid } from "../shelfMap.js";

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
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {cameraConfig &&
              resolution &&
              !options.some((option) => option.value === resolution) && (
                <option value={resolution}>{`${resolution} (current)`}</option>
              )}
          </select>
        </div>
        <div className="settings-field">
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
