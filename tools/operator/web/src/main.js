import Chart from "chart.js/auto";
import { createEmptyShelfGrid, validateShelfGrid } from "./shelfMap.js";

// ==================== Constants ====================
const API_BASE = "";
const WS_RECONNECT_DELAY_MS = 2000;
const DIAGNOSTICS_REFRESH_INTERVAL_MS = 10_000;
const INFO_REFRESH_INTERVAL_MS = 30_000;
const MAX_TELEMETRY_POINTS = 120;
const TOAST_DURATION_MS = 4000;
const CAMERA_WS_RECONNECT_DELAY_MS = 3000;
const LOG_WS_RECONNECT_DELAY_MS = 3000;

const METRIC_CONFIG = [
  { key: "elev_mm", label: "Elev (mm)", color: "#20639b" },
  { key: "grip_pos_deg", label: "Grip (deg)", color: "#3caea3" },
  { key: "lineL_adc", label: "Line L", color: "#f6d55c" },
  { key: "lineR_adc", label: "Line R", color: "#ed553b" },
  { key: "vbatt_mV", label: "Vbatt (mV)", color: "#173f5f" },
];

const DEFAULT_SHELF_PALETTE = [
  { id: "-", label: "Empty", color: "#0f172a" },
  { id: "R", label: "Red", color: "#ef4444" },
  { id: "G", label: "Green", color: "#22c55e" },
  { id: "B", label: "Blue", color: "#3b82f6" },
  { id: "Y", label: "Yellow", color: "#facc15" },
  { id: "W", label: "White", color: "#f8fafc" },
  { id: "K", label: "Black", color: "#111827" },
];

function contrastTextColor(hex) {
  if (!hex || typeof hex !== "string") {
    return "var(--color-text)";
  }
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6 && normalized.length !== 3) {
    return "var(--color-text)";
  }
  const expanded = normalized.length === 3
    ? normalized
        .split("")
        .map((char) => char + char)
        .join("")
    : normalized;
  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);
  if ([r, g, b].some((component) => Number.isNaN(component))) {
    return "var(--color-text)";
  }
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#0f172a" : "#f8fafc";
}

// ==================== DOM Elements ====================
let statusGrid;
let refreshButton;
let refreshCamera;
let clearOutput;
let telemetryLegend;
let startForm;
let commandForm;
let startTaskInput;
let rawCommandInput;
let brakeButton;
let commandOutput;
let wsStatusEl;
let toastContainer;
let modalOverlay;
let modalTitle;
let modalMessage;
let modalConfirm;
let modalCancel;
let cameraFeed;
let cameraPlaceholder;
let cameraTransportBadge;
let toggleCameraStreamButton;
let logOutput;
let refreshLogs;
let settingsCameraForm;
let settingsCameraResolution;
let settingsCameraQuality;
let settingsCameraQualityValue;
let settingsCameraRefresh;
let settingsCameraStatus;
let serviceCameraStreaming = null;
let serviceCameraSource = "auto";
let serviceCameraSnapshotUrl = null;
let shelfMapForm;
let shelfMapGrid;
let shelfMapStatus;
let shelfMapReloadButton;
let shelfMapResetButton;
let shelfMapPersistCheckbox;

// Tabs
let tabButtons;
let tabContents;

// ==================== State ====================
let wsConnection = null;
let wsReconnectTimeout = null;
let diagnosticsRefreshInterval = null;
let modalResolve = null;
let infoRefreshInterval = null;
let chartCtx = null;
let chart = null;
let cameraSocket = null;
let cameraReconnectTimeout = null;
let cameraPlaceholderDefaultMessage = "";
let lastCameraErrorMessage = "";
let cameraStreamDesired = false;
let cameraTogglePending = false;
let logSocket = null;
let logReconnectTimeout = null;
let logStreamDesired = false;
let cameraConfigState = null;
let cameraSettingsBusy = false;
let activeTabName = null;
let shelfMapState = null;
let shelfMapPalette = DEFAULT_SHELF_PALETTE.map((item) => ({ ...item }));
let shelfMapBusy = false;

// ==================== Chart Setup ====================
function createChart(context) {
  return new Chart(context, {
    type: "line",
    data: { labels: [], datasets: [] },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(15, 23, 42, 0.9)",
          titleColor: "#e2e8f0",
          bodyColor: "#cbd5e1",
          borderColor: "#475569",
          borderWidth: 1,
          padding: 12,
          displayColors: true,
        },
      },
      scales: {
        x: {
          display: true,
          title: { display: true, text: "Time" },
          grid: { color: "#e2e8f0" },
        },
        y: {
          display: true,
          title: { display: true, text: "Value" },
          grid: { color: "#e2e8f0" },
        },
      },
    },
  });
}

const datasetMap = new Map();

const headerStatusState = {
  phase: "connecting",
  robotConnected: false,
  medium: null,
  ip: null,
  stale: true,
};

function renderHeaderStatus() {
  if (!wsStatusEl) return;
  const { phase, robotConnected, medium, ip, stale } = headerStatusState;
  const classNames = ["status-indicator"];
  let text = "Connecting...";

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

  wsStatusEl.className = classNames.join(" ");
  const textEl = wsStatusEl.querySelector(".status-text");
  if (textEl) {
    textEl.textContent = text;
  }
}

function setHeaderStatus(update = {}) {
  Object.assign(headerStatusState, update);
  renderHeaderStatus();
}

function setWsPhase(phase) {
  headerStatusState.phase = phase;
  renderHeaderStatus();
}

// ==================== Utilities ====================

function showToast(message, type = "info") {
  if (!toastContainer) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      ${
        type === "success"
          ? '<path d="M20 6L9 17l-5-5"/>'
          : type === "error"
          ? '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'
          : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'
      }
    </svg>
    <div class="toast-message">${message}</div>
  `;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), TOAST_DURATION_MS);
}

function showModal(title, message) {
  return new Promise((resolve) => {
    if (modalTitle) modalTitle.textContent = title;
    if (modalMessage) modalMessage.textContent = message;
    if (modalOverlay) modalOverlay.removeAttribute("hidden");
    modalResolve = resolve;
    if (modalConfirm) {
      modalConfirm.focus();
    }
  });
}

function updateCameraTransportBadge({ transport, snapshotUrl, streaming, source, error }) {
  if (!cameraTransportBadge) return;

  if (error) {
    cameraTransportBadge.textContent = "Camera: Error";
    cameraTransportBadge.className = "badge badge-error";
    cameraTransportBadge.title = error;
    cameraTransportBadge.dataset.transport = "error";
    cameraTransportBadge.dataset.streaming = "error";
    return;
  }

  const normalized = (transport || "unknown").toLowerCase();
  const labelMap = {
    wifi: "Wi-Fi",
    "type-c": "Type-C",
    unconfigured: "Not Configured",
    unknown: "Unknown",
  };

  const label = labelMap[normalized] || "Unknown";
  const streamingLabel =
    streaming === true ? "Streaming" : streaming === false ? "Idle" : "Unknown";
  let badgeClass = "badge";

  switch (normalized) {
    case "wifi":
      badgeClass += " badge-wifi";
      break;
    case "type-c":
      badgeClass += " badge-type-c";
      break;
    case "unconfigured":
      badgeClass += " badge-muted";
      break;
    case "unknown":
    default:
      badgeClass += " badge-unknown";
  }

  cameraTransportBadge.textContent = `Camera: ${label} • ${streamingLabel}`;
  cameraTransportBadge.className = badgeClass;
  const sourceLabel = source === "override" ? "Manual URL" : "Auto";
  const tooltipParts = [];
  tooltipParts.push(`Mode: ${sourceLabel}`);
  if (snapshotUrl) tooltipParts.push(`Snapshot: ${snapshotUrl}`);
  cameraTransportBadge.title = tooltipParts.join("\n");
  cameraTransportBadge.dataset.transport = normalized;
  cameraTransportBadge.dataset.streaming = streamingLabel.toLowerCase();
}

function updateCameraToggleControls() {
  if (!toggleCameraStreamButton) return;

  const overrideActive = serviceCameraSource === "override";
  const streamingState = serviceCameraStreaming;

  const button = toggleCameraStreamButton;

  const setBaseClass = (classes) => {
    button.className = `${classes} btn-sm`;
  };

  if (overrideActive) {
    setBaseClass("btn-secondary");
    button.disabled = true;
    button.textContent = "Manual URL Active";
    button.title = "Streaming managed by manual override URL";
    button.dataset.state = "override";
    return;
  }

  if (cameraTogglePending) {
    setBaseClass(streamingState ? "btn-danger" : "btn-primary");
    button.disabled = true;
    button.textContent = "Applying...";
    button.title = "Waiting for ESP32 response";
    button.dataset.state = "pending";
    return;
  }

  if (streamingState === null) {
    setBaseClass("btn-secondary");
    button.disabled = true;
    button.textContent = "Stream Status...";
    button.title = "Awaiting status update from ESP32";
    button.dataset.state = "unknown";
    return;
  }

  const isStreaming = streamingState === true;
  setBaseClass(isStreaming ? "btn-danger" : "btn-primary");
  button.disabled = false;
  button.textContent = isStreaming ? "Disable Stream" : "Enable Stream";
  button.title = isStreaming ? "Send CAMSTREAM OFF" : "Send CAMSTREAM ON";
  button.dataset.state = isStreaming ? "on" : "off";
}

function handleCameraStreamingStateUpdate() {
  updateCameraToggleControls();

  if (serviceCameraStreaming === false && serviceCameraSource !== "override") {
    disconnectCameraStream({ clearFrame: true });
    showCameraPlaceholder("Camera stream disabled. Use Enable Stream above.");
  } else if (serviceCameraStreaming === true && cameraStreamDesired) {
    connectCameraStream();
  }
}

function hideModal(result) {
  if (modalOverlay) {
    modalOverlay.setAttribute("hidden", "");
  }
  if (!modalResolve) return;
  modalResolve(result);
  modalResolve = null;
}

// ==================== Chart Management ====================
function ensureDataset(metric) {
  if (!chart) return null;
  if (datasetMap.has(metric.key)) {
    return datasetMap.get(metric.key);
  }
  const dataset = {
    label: metric.label,
    data: [],
    borderColor: metric.color,
    backgroundColor: `${metric.color}20`,
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
  };
  chart.data.datasets.push(dataset);
  datasetMap.set(metric.key, dataset);
  renderLegend();
  return dataset;
}

function renderLegend() {
  if (!telemetryLegend) return;
  telemetryLegend.innerHTML = "";
  datasetMap.forEach((dataset, key) => {
    const metric = METRIC_CONFIG.find((item) => item.key === key);
    if (!metric) return;
    const badge = document.createElement("span");
    badge.className = "legend-item";
    badge.setAttribute("role", "listitem");
    badge.style.setProperty("--color", metric.color);
    badge.innerHTML = `<i></i><span>${dataset.label}</span>`;
    telemetryLegend.appendChild(badge);
  });
}

function truncateDatasets() {
  if (!chart) return;
  if (chart.data.labels.length > MAX_TELEMETRY_POINTS) {
    const excess = chart.data.labels.length - MAX_TELEMETRY_POINTS;
    chart.data.labels.splice(0, excess);
    chart.data.datasets.forEach((dataset) => {
      dataset.data.splice(0, excess);
    });
  }
}

function pushTelemetrySample(data) {
  if (!chart) return;
  const timestamp = new Date().toLocaleTimeString();
  chart.data.labels.push(timestamp);
  METRIC_CONFIG.forEach((metric) => {
    const dataset = ensureDataset(metric);
    const value = data[metric.key];
    dataset.data.push(value ?? null);
  });
  truncateDatasets();
  chart.update("none");
}

// ==================== API Calls ====================
async function fetchDiagnostics() {
  try {
    const response = await fetch(`${API_BASE}/api/diagnostics`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const payload = await response.json();
    renderDiagnostics(payload || {});
  } catch (error) {
    console.error("Diagnostics fetch error:", error);
    showToast(`Failed to fetch diagnostics: ${error.message}`, "error");
    setHeaderStatus({ robotConnected: false, medium: null, ip: null, stale: true });
  }
}

async function fetchServiceInfo() {
  try {
    const response = await fetch(`${API_BASE}/api/info`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    updateCameraTransportBadge({
      transport: payload.camera_transport,
      snapshotUrl: payload.camera_snapshot_url,
      streaming: payload.camera_streaming,
      source: payload.camera_snapshot_source,
    });
    serviceCameraStreaming = payload.camera_streaming;
    serviceCameraSource = payload.camera_snapshot_source || "auto";
    serviceCameraSnapshotUrl = payload.camera_snapshot_url || null;
    if (cameraConfigState) {
      if (!cameraSettingsBusy && settingsCameraForm) {
        renderCameraSettings(
          { ...cameraConfigState, running: Boolean(payload.camera_streaming) },
          { preserveStatus: true }
        );
      } else {
        cameraConfigState = { ...cameraConfigState, running: Boolean(payload.camera_streaming) };
      }
    }
    handleCameraStreamingStateUpdate();
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Service info fetch error:", error);
    updateCameraTransportBadge({ error: message || "Unavailable" });
    serviceCameraStreaming = null;
    serviceCameraSource = "auto";
    serviceCameraSnapshotUrl = null;
    if (cameraConfigState) {
      if (!cameraSettingsBusy && settingsCameraForm) {
        renderCameraSettings({ ...cameraConfigState, running: false }, { preserveStatus: true });
      } else {
        cameraConfigState = { ...cameraConfigState, running: false };
      }
    }
    handleCameraStreamingStateUpdate();
    return null;
  }
}

async function sendCommand(command, raiseOnError = false) {
  const response = await fetch(`${API_BASE}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, raise_on_error: raiseOnError }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || "Command failed");
  }
  return response.json();
}

// ==================== Camera Settings Helpers ====================
function setCameraSettingsStatus(message, type = "info") {
  if (!settingsCameraStatus) return;
  let className = "settings-status";
  if (type === "success") className += " success";
  else if (type === "error") className += " error";
  settingsCameraStatus.className = className;
  settingsCameraStatus.textContent = message || "";
}

function setCameraSettingsBusyState(isBusy, { label } = {}) {
  cameraSettingsBusy = isBusy;
  if (!settingsCameraForm) return;

  const submitButton = settingsCameraForm.querySelector('button[type="submit"]');
  if (submitButton) {
    if (!submitButton.dataset.defaultLabel) {
      submitButton.dataset.defaultLabel = submitButton.textContent || "Apply Changes";
    }
    submitButton.disabled = isBusy;
    submitButton.textContent = isBusy
      ? label || submitButton.dataset.defaultLabel
      : submitButton.dataset.defaultLabel;
  }

  const controls = [settingsCameraResolution, settingsCameraQuality, settingsCameraRefresh];
  controls.forEach((control) => {
    if (control) control.disabled = isBusy;
  });
}

function syncCameraQualityValueDisplay(value) {
  if (!settingsCameraQualityValue) return;
  if (typeof value === "number" && !Number.isNaN(value)) {
    settingsCameraQualityValue.textContent = value.toString();
  } else {
    settingsCameraQualityValue.textContent = "—";
  }
}

function updateCameraQualityDisplayFromControl() {
  if (!settingsCameraQuality) return;
  const parsed = Number.parseInt(settingsCameraQuality.value, 10);
  syncCameraQualityValueDisplay(Number.isNaN(parsed) ? null : parsed);
}

function populateCameraResolutionOptions(options, selected) {
  if (!settingsCameraResolution) return;
  const select = settingsCameraResolution;
  const desired = (selected || select.value || "").toUpperCase();

  select.innerHTML = "";
  (options || []).forEach((item) => {
    if (!item) return;
    const value = (item.id || item.value || item.label || "").toString().toUpperCase();
    if (!value) return;
    const option = document.createElement("option");
    const width = item.width ? `${item.width}` : null;
    const height = item.height ? `${item.height}` : null;
    const label = item.label || value;
    const dimensions = width && height ? `${width}×${height}` : null;
    option.value = value;
    option.textContent = dimensions ? `${label} (${dimensions})` : label;
    select.appendChild(option);
  });

  if (desired) {
    const match = Array.from(select.options).some((option) => option.value === desired);
    if (!match) {
      const option = document.createElement("option");
      option.value = desired;
      option.textContent = `${desired} (current)`;
      select.appendChild(option);
    }
    select.value = desired;
  }
}

function renderCameraSettings(config, { statusMessage, statusType = "info", preserveStatus = false } = {}) {
  if (!settingsCameraForm || !config) return;

  const parsedQuality = Number.parseInt(config.quality, 10);
  const parsedQualityMin = Number.parseInt(config.quality_min, 10);
  const parsedQualityMax = Number.parseInt(config.quality_max, 10);

  const normalized = {
    resolution: (config.resolution || "").toString().toUpperCase() || "UNKNOWN",
    quality: Number.isNaN(parsedQuality) ? null : parsedQuality,
    running: Boolean(config.running),
    available_resolutions: Array.isArray(config.available_resolutions)
      ? config.available_resolutions
      : [],
    quality_min: Number.isNaN(parsedQualityMin) ? 10 : parsedQualityMin,
    quality_max: Number.isNaN(parsedQualityMax) ? 63 : parsedQualityMax,
  };

  cameraConfigState = normalized;

  populateCameraResolutionOptions(normalized.available_resolutions, normalized.resolution);

  if (settingsCameraQuality) {
    settingsCameraQuality.min = String(normalized.quality_min);
    settingsCameraQuality.max = String(normalized.quality_max);
    if (document.activeElement !== settingsCameraQuality) {
      const value = normalized.quality ?? normalized.quality_min;
      settingsCameraQuality.value = String(value);
    }
  }

  updateCameraQualityDisplayFromControl();

  if (typeof statusMessage === "string") {
    setCameraSettingsStatus(statusMessage, statusType);
  } else if (!preserveStatus) {
    const streamLabel = normalized.running ? "Streaming" : "Idle";
    const qualityLabel = normalized.quality !== null ? normalized.quality : "—";
    setCameraSettingsStatus(
      `Current: ${normalized.resolution} • Quality ${qualityLabel} • ${streamLabel}`,
      normalized.running ? "success" : "info"
    );
  }
}

async function fetchCameraConfig({ showLoading = false, silent = false } = {}) {
  if (!settingsCameraForm || cameraSettingsBusy) return cameraConfigState;

  if (showLoading) {
    setCameraSettingsBusyState(true, { label: "Loading..." });
    if (!silent) {
      setCameraSettingsStatus("Loading camera configuration…", "info");
    }
  }

  try {
    const response = await fetch(`${API_BASE}/api/camera/config`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    renderCameraSettings(payload);
    if (!silent) {
      showToast("Camera settings refreshed", "success");
    }
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to fetch camera settings:", error);
    if (!silent) {
      showToast(`Failed to fetch camera settings: ${message}`, "error");
    }
    setCameraSettingsStatus(message || "Failed to load camera settings", "error");
    return null;
  } finally {
    if (showLoading) {
      setCameraSettingsBusyState(false);
    }
  }
}

async function submitCameraSettings(event) {
  if (event) {
    event.preventDefault();
  }
  if (!settingsCameraForm || cameraSettingsBusy) return;

  const payload = {};
  const resolutionValue = settingsCameraResolution ? settingsCameraResolution.value : "";
  const qualityValue = settingsCameraQuality ? Number.parseInt(settingsCameraQuality.value, 10) : NaN;

  if (resolutionValue && (!cameraConfigState || resolutionValue !== cameraConfigState.resolution)) {
    payload.resolution = resolutionValue;
  }

  if (!Number.isNaN(qualityValue) && (!cameraConfigState || qualityValue !== cameraConfigState.quality)) {
    payload.quality = qualityValue;
  }

  if (!payload.resolution && payload.quality === undefined) {
    setCameraSettingsStatus("No changes to apply.", "info");
    showToast("No camera settings changes detected", "info");
    return;
  }

  setCameraSettingsBusyState(true, { label: "Applying..." });
  setCameraSettingsStatus("Applying camera settings…", "info");

  try {
    const response = await fetch(`${API_BASE}/api/camera/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      const detail = errorPayload.detail || errorPayload.error || response.statusText;
      throw new Error(detail || "Failed to update camera settings");
    }

    const result = await response.json();
    renderCameraSettings(result);
    setCameraSettingsStatus("Camera settings updated", "success");
    showToast("Camera settings updated", "success");
    await Promise.allSettled([fetchServiceInfo(), fetchDiagnostics()]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to update camera settings:", error);
    setCameraSettingsStatus(message || "Failed to update camera settings", "error");
    showToast(message || "Failed to update camera settings", "error");
  } finally {
    setCameraSettingsBusyState(false);
  }
}

// ==================== Shelf Map Settings Helpers ====================
function normalizeShelfPalette(palette) {
  const candidates = Array.isArray(palette) && palette.length ? palette : DEFAULT_SHELF_PALETTE;
  const deduped = [];
  const seen = new Set();
  candidates.forEach((entry) => {
    if (!entry) return;
    const id = (entry.id || entry.code || entry.value || "-").toString().trim().toUpperCase();
    if (!id || seen.has(id)) return;
    seen.add(id);
    const label = entry.label || id;
    const colorSource = entry.color || (DEFAULT_SHELF_PALETTE.find((item) => item.id === id) || {}).color;
    const color = typeof colorSource === "string" ? colorSource : "#0f172a";
    deduped.push({ id, label, color });
  });
  if (!deduped.length) {
    return DEFAULT_SHELF_PALETTE.map((item) => ({ ...item }));
  }
  return deduped;
}

function setShelfMapStatus(message, type = "info") {
  if (!shelfMapStatus) return;
  let className = "settings-status";
  if (type === "success") className += " success";
  else if (type === "error") className += " error";
  shelfMapStatus.className = className;
  shelfMapStatus.textContent = message || "";
}

function setShelfMapBusyState(isBusy, { label } = {}) {
  shelfMapBusy = isBusy;
  if (!shelfMapForm) return;

  const submitButton = shelfMapForm.querySelector('button[type="submit"]');
  if (submitButton) {
    if (!submitButton.dataset.defaultLabel) {
      submitButton.dataset.defaultLabel = submitButton.textContent || "Apply Changes";
    }
    submitButton.disabled = isBusy;
    submitButton.textContent = isBusy
      ? label || submitButton.dataset.defaultLabel
      : submitButton.dataset.defaultLabel;
  }

  const selectControls = shelfMapGrid
    ? Array.from(shelfMapGrid.querySelectorAll("select.shelf-map-select"))
    : [];
  selectControls.forEach((control) => {
    control.disabled = isBusy;
  });

  if (shelfMapReloadButton) shelfMapReloadButton.disabled = isBusy;
  if (shelfMapResetButton) shelfMapResetButton.disabled = isBusy;
  if (shelfMapPersistCheckbox) shelfMapPersistCheckbox.disabled = isBusy;
}

function populateShelfMapOptions(select, palette) {
  const desired = (select.value || "-").toString().trim().toUpperCase();
  select.innerHTML = "";
  palette.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.label || entry.id;
    option.dataset.color = entry.color;
    select.appendChild(option);
  });
  if (desired) {
    const hasDesired = palette.some((entry) => entry.id === desired);
    select.value = hasDesired ? desired : palette[0]?.id || "-";
  }
}

function updateShelfMapCellVisual(select, palette = shelfMapPalette) {
  if (!select) return;
  const code = (select.value || "-").toString().trim().toUpperCase();
  const entry = (palette || []).find((item) => item.id === code);
  const color = entry && entry.color ? entry.color : null;
  if (color) {
    select.style.setProperty("--cell-color", color);
    select.style.setProperty("--cell-text-color", contrastTextColor(color));
    select.dataset.color = color;
  } else {
    select.style.removeProperty("--cell-color");
    select.style.removeProperty("--cell-text-color");
    select.removeAttribute("data-color");
  }
  select.dataset.code = code;
}

function ensureShelfMapControls(palette) {
  if (!shelfMapGrid) return [];
  const selects = shelfMapGrid.querySelectorAll("select.shelf-map-select");
  if (selects.length === 9) {
    selects.forEach((select) => populateShelfMapOptions(select, palette));
    return Array.from(selects);
  }

  shelfMapGrid.innerHTML = "";
  const created = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const select = document.createElement("select");
      select.className = "shelf-map-select";
      select.dataset.row = String(row);
      select.dataset.col = String(col);
      select.setAttribute("aria-label", `Row ${row + 1}, Column ${col + 1}`);
  populateShelfMapOptions(select, palette);
  select.addEventListener("change", () => updateShelfMapCellVisual(select));
      shelfMapGrid.appendChild(select);
      created.push(select);
    }
  }
  return created;
}

function renderShelfMapGrid(grid, palette) {
  if (!shelfMapGrid) return;
  const normalizedPalette = normalizeShelfPalette(palette || shelfMapPalette);
  shelfMapPalette = normalizedPalette;
  const allowed = normalizedPalette.map((entry) => entry.id);
  let normalizedGrid;
  try {
    normalizedGrid = validateShelfGrid(grid, allowed);
  } catch (error) {
    normalizedGrid = createEmptyShelfGrid();
  }
  const selects = ensureShelfMapControls(normalizedPalette);
  selects.forEach((select) => {
    const row = Number.parseInt(select.dataset.row || "0", 10);
    const col = Number.parseInt(select.dataset.col || "0", 10);
    const value = normalizedGrid[row] && normalizedGrid[row][col] ? normalizedGrid[row][col] : "-";
    select.value = value;
    updateShelfMapCellVisual(select, normalizedPalette);
  });
}

function collectShelfMapGrid() {
  if (!shelfMapGrid) {
    throw new Error("Shelf map controls unavailable");
  }
  const result = createEmptyShelfGrid();
  const selects = shelfMapGrid.querySelectorAll("select.shelf-map-select");
  selects.forEach((select) => {
    const row = Number.parseInt(select.dataset.row || "0", 10);
    const col = Number.parseInt(select.dataset.col || "0", 10);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 2 || col < 0 || col > 2) {
      return;
    }
    result[row][col] = (select.value || "-").toString().trim().toUpperCase();
  });
  const allowed = shelfMapPalette.map((entry) => entry.id);
  return validateShelfGrid(result, allowed);
}

async function fetchShelfMap({ showLoading = false, silent = false } = {}) {
  if (!shelfMapForm || shelfMapBusy) {
    return shelfMapState;
  }

  if (showLoading) {
    setShelfMapBusyState(true, { label: "Loading..." });
    if (!silent) {
      setShelfMapStatus("Loading shelf map…", "info");
    }
  }

  try {
    const response = await fetch(`${API_BASE}/api/shelf-map`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const payload = await response.json();
    shelfMapState = payload;
    renderShelfMapGrid(payload.grid || createEmptyShelfGrid(), payload.palette);
    if (!silent) {
      setShelfMapStatus("Shelf map loaded", "success");
      showToast("Shelf map loaded", "success");
    }
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to fetch shelf map:", error);
    setShelfMapStatus(message || "Failed to load shelf map", "error");
    if (!silent) {
      showToast(`Failed to load shelf map: ${message}`, "error");
    }
    return null;
  } finally {
    if (showLoading) {
      setShelfMapBusyState(false);
    }
  }
}

async function submitShelfMap(event) {
  if (event) event.preventDefault();
  if (!shelfMapForm || shelfMapBusy) return;

  let grid;
  try {
    grid = collectShelfMapGrid();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setShelfMapStatus(message, "error");
    showToast(message, "error");
    return;
  }

  const persist = shelfMapPersistCheckbox ? Boolean(shelfMapPersistCheckbox.checked) : false;

  setShelfMapBusyState(true, { label: "Applying..." });
  setShelfMapStatus("Applying shelf map…", "info");

  try {
    const response = await fetch(`${API_BASE}/api/shelf-map`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grid, persist }),
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      const detail = errorPayload.detail || errorPayload.error || response.statusText;
      throw new Error(detail || "Failed to update shelf map");
    }
    const payload = await response.json();
    shelfMapState = payload;
    renderShelfMapGrid(payload.grid || grid, payload.palette);
    const message = persist ? "Shelf map saved to flash" : "Shelf map updated";
    setShelfMapStatus(message, "success");
    showToast(message, "success");
    await Promise.allSettled([fetchDiagnostics(), fetchServiceInfo()]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to update shelf map:", error);
    setShelfMapStatus(message || "Failed to update shelf map", "error");
    showToast(message || "Failed to update shelf map", "error");
  } finally {
    setShelfMapBusyState(false);
  }
}

async function resetShelfMap(event) {
  if (event) event.preventDefault();
  if (!shelfMapForm || shelfMapBusy) return;

  const confirmed = await showModal(
    "Reset Shelf Map",
    "Restore the default color layout on the robot? Current assignments will be lost."
  );
  if (!confirmed) return;

  const persist = shelfMapPersistCheckbox ? Boolean(shelfMapPersistCheckbox.checked) : false;
  setShelfMapBusyState(true, { label: "Resetting..." });
  setShelfMapStatus("Resetting shelf map…", "info");

  try {
    const response = await fetch(`${API_BASE}/api/shelf-map/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persist }),
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      const detail = errorPayload.detail || errorPayload.error || response.statusText;
      throw new Error(detail || "Failed to reset shelf map");
    }
    const payload = await response.json();
    shelfMapState = payload;
    renderShelfMapGrid(payload.grid || createEmptyShelfGrid(), payload.palette);
    const message = persist
      ? "Shelf map reset and saved to flash"
      : "Shelf map reset to firmware defaults";
    setShelfMapStatus(message, "success");
    showToast(message, "success");
    await Promise.allSettled([fetchDiagnostics(), fetchServiceInfo()]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to reset shelf map:", error);
    setShelfMapStatus(message || "Failed to reset shelf map", "error");
    showToast(message || "Failed to reset shelf map", "error");
  } finally {
    setShelfMapBusyState(false);
  }
}

// ==================== Rendering ====================
function createStatusCard({ title, value, tone = "default", details = [] }) {
  const card = document.createElement("div");
  card.className = "status-card";
  if (tone && tone !== "default") {
    card.dataset.state = tone;
  }
  const safeTitle = title.replace(/_/g, " ");
  card.innerHTML = `<h3>${safeTitle}</h3><span>${value}</span>`;
  if (details.length) {
    const list = document.createElement("ul");
    list.className = "status-card-details";
    details.forEach((detail) => {
      if (!detail) return;
      const item = document.createElement("li");
      item.textContent = detail;
      list.appendChild(item);
    });
    if (list.childNodes.length) {
      card.appendChild(list);
    }
  }
  return card;
}

function renderDiagnostics(diagnostics) {
  if (!statusGrid) return;
  if (!diagnostics || typeof diagnostics !== "object" || !Object.keys(diagnostics).length) {
    statusGrid.innerHTML = '<p style="grid-column: 1/-1; color: var(--color-text-muted); text-align: center;">No diagnostics data available</p>';
    return;
  }

  const cards = [];
  const serial = diagnostics.serial || {};
  const uno = diagnostics.uno || {};
  const wifi = diagnostics.wifi || {};
  const camera = diagnostics.camera || {};
  const status = diagnostics.status || {};
  const meta = diagnostics.meta || {};
  const diagTimestamp = diagnostics.timestamp ? new Date(diagnostics.timestamp * 1000).toLocaleTimeString() : null;
  const statusFresh =
    meta.status_fresh !== undefined ? Boolean(meta.status_fresh) : Boolean(serial.connected || wifi.connected === true);

  const wifiConnected = statusFresh && wifi.connected === true;
  const serialConnected = statusFresh && serial.connected === true;
  const robotConnected = wifiConnected || serialConnected;
  const connectionMedium = wifiConnected ? "wifi" : serialConnected ? "type-c" : null;
  const connectionIp = wifiConnected && typeof wifi.ip === "string" ? wifi.ip : null;

  setHeaderStatus({
    robotConnected,
    medium: connectionMedium,
    ip: connectionIp,
    stale: !statusFresh,
  });

  const serialStatusErrorDetail =
    serial.status_error === "no_data"
      ? "Status error: no data from ESP32"
      : serial.status_error
      ? `Status error: ${serial.status_error}`
      : null;

  if (typeof camera.streaming === "boolean") {
    serviceCameraStreaming = camera.streaming;
  }
  if (camera.source) {
    serviceCameraSource = camera.source;
  }
  if (camera.snapshot_url !== undefined) {
    serviceCameraSnapshotUrl = camera.snapshot_url || null;
  }
  if (camera.streaming !== undefined) {
    serviceCameraStreaming = camera.streaming;
  }
  handleCameraStreamingStateUpdate();

  cards.push(
    createStatusCard({
      title: "ESP32 Serial",
      value: serial.connected ? "Connected" : "Disconnected",
      tone: serial.connected ? "ok" : "error",
      details: [
        diagTimestamp && `Updated: ${diagTimestamp}`,
        serial.active_port ? `Port: ${serial.active_port}` : serial.requested_port ? `Requested: ${serial.requested_port}` : "Auto detect",
        serial.error && `Error: ${serial.error}`,
        serialStatusErrorDetail,
        typeof serial.status_age_s === "number" && Number.isFinite(serial.status_age_s)
          ? `Last update: ${serial.status_age_s.toFixed(1)} s ago`
          : null,
        serial.stale ? "Status stale" : null,
      ],
    })
  );

  cards.push(
    createStatusCard({
      title: "UNO / I2C",
      value: uno.connected ? "Online" : "Offline",
      tone: uno.connected ? "ok" : "error",
      details: [
        uno.error && `status_error=${uno.error}`,
        uno.state_id !== undefined && `state_id=${uno.state_id}`,
        uno.err_flags !== undefined && `err_flags=${uno.err_flags}`,
        uno.seq_ack !== undefined && `seq_ack=${uno.seq_ack}`,
      ],
    })
  );

  cards.push(
    createStatusCard({
      title: "Wi-Fi",
      value: wifi.connected === true ? "Connected" : wifi.connected === false ? "Disconnected" : "Unknown",
      tone: wifi.connected === false ? "warn" : wifi.connected === true ? "ok" : "default",
      details: [wifi.ip && `IP: ${wifi.ip}`],
    })
  );

  cards.push(
    createStatusCard({
      title: "Camera",
      value: camera.configured ? "Configured" : "Missing",
      tone: camera.configured ? "ok" : "warn",
      details: [
        camera.resolution && `Resolution: ${camera.resolution}`,
        camera.quality !== undefined && `Quality: ${camera.quality}`,
        camera.transport && `Transport: ${camera.transport}`,
        camera.snapshot_url && `Snapshot: ${camera.snapshot_url}`,
        camera.streaming !== undefined && `Streaming: ${camera.streaming ? "ON" : "OFF"}`,
        camera.source && `Source: ${camera.source}`,
        camera.stream_interval_ms && `Stream interval: ${camera.stream_interval_ms} ms`,
      ],
    })
  );

  const statusDetails = [];
  if (status.vbatt_mV !== undefined) statusDetails.push(`Vbatt: ${status.vbatt_mV} mV`);
  if (status.line_left !== undefined && status.line_right !== undefined) {
    statusDetails.push(`Line L/R: ${status.line_left}/${status.line_right}`);
  }
  if (status.odo_left !== undefined && status.odo_right !== undefined) {
    statusDetails.push(`ODO L/R: ${status.odo_left}/${status.odo_right}`);
  }
  if (status.status_error) statusDetails.push(`Error: ${status.status_error}`);
  if (!statusFresh) {
    statusDetails.push("No fresh STATUS data");
  }
  if (meta.status_error && meta.status_error !== "no_data") {
    statusDetails.push(`Status error: ${meta.status_error}`);
  }

  const statusCardValue = statusFresh ? (status.status_error ? "Errors" : "Nominal") : "Unavailable";
  const statusCardTone = statusFresh ? (status.status_error ? "warn" : "default") : "warn";

  cards.push(
    createStatusCard({
      title: "STATUS Snapshot",
      value: statusCardValue,
      tone: statusCardTone,
      details: statusDetails,
    })
  );

  statusGrid.innerHTML = "";
  cards.forEach((card) => statusGrid.appendChild(card));
}

function handleTelemetryMessage(payload) {
  if (payload.data) {
    pushTelemetrySample(payload.data);
  }
  if (payload.error) {
    console.error("Telemetry error:", payload.error);
    setHeaderStatus({ robotConnected: false, medium: null, ip: null, stale: true });
  }
}

function formatLogEntry(entry) {
  if (!entry) return "";
  const timestamp = entry.timestamp ? new Date(entry.timestamp * 1000).toLocaleTimeString() : "--:--:--";
  return `[${timestamp}] ${entry.line ?? ""}`;
}

function appendLogEntries(entries, { replace = false } = {}) {
  if (!logOutput || !Array.isArray(entries) || !entries.length) {
    if (replace && logOutput) {
      logOutput.textContent = "";
    }
    return;
  }

  const content = entries.map((entry) => formatLogEntry(entry)).filter(Boolean).join("\n");
  if (replace) {
    logOutput.textContent = content ? `${content}\n` : "";
  } else {
    if (logOutput.textContent && !logOutput.textContent.endsWith("\n")) {
      logOutput.textContent += "\n";
    }
    logOutput.textContent += content ? `${content}\n` : "";
  }
  logOutput.scrollTop = logOutput.scrollHeight;
}

async function fetchLogsSnapshot(limit = 200) {
  if (!logOutput) return;
  try {
    const response = await fetch(`${API_BASE}/api/logs?limit=${limit}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const payload = await response.json();
    appendLogEntries(payload.lines || [], { replace: true });
  } catch (error) {
    console.error("Log snapshot error:", error);
    showToast(`Failed to fetch logs: ${error.message}`, "error");
  }
}

function connectLogStream() {
  if (!logStreamDesired || !logOutput) return;
  if (
    logSocket &&
    (logSocket.readyState === WebSocket.OPEN || logSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/logs`);

  socket.addEventListener("open", () => {
    if (logReconnectTimeout) {
      clearTimeout(logReconnectTimeout);
      logReconnectTimeout = null;
    }
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "snapshot") {
        appendLogEntries(payload.lines || [], { replace: true });
      } else if (payload.type === "log") {
        appendLogEntries([payload]);
      }
    } catch (error) {
      console.error("Failed to parse log payload:", error);
    }
  });

  socket.addEventListener("close", () => {
    logSocket = null;
    if (logStreamDesired) {
      logReconnectTimeout = setTimeout(connectLogStream, LOG_WS_RECONNECT_DELAY_MS);
    }
  });

  socket.addEventListener("error", (event) => {
    console.error("Log WebSocket error:", event);
    socket.close();
  });

  logSocket = socket;
}

function restartLogStream() {
  if (logSocket) {
    try {
      logSocket.close();
    } catch (error) {
      console.error("Error closing log WebSocket:", error);
    }
    logSocket = null;
  }
  connectLogStream();
}

function disconnectLogStream() {
  if (logReconnectTimeout) {
    clearTimeout(logReconnectTimeout);
    logReconnectTimeout = null;
  }
  if (logSocket) {
    try {
      logSocket.close();
    } catch (error) {
      console.error("Error closing log WebSocket:", error);
    }
    logSocket = null;
  }
}

// ==================== WebSocket ====================
function connectWebSocket() {
  if (
    wsConnection &&
    (wsConnection.readyState === WebSocket.OPEN || wsConnection.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  setWsPhase("connecting");
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/telemetry`);

  socket.addEventListener("open", () => {
    setWsPhase("connected");
    showToast("WebSocket connected", "success");
    if (wsReconnectTimeout) {
      clearTimeout(wsReconnectTimeout);
      wsReconnectTimeout = null;
    }
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleTelemetryMessage(payload);
    } catch (error) {
      console.error("Failed to parse telemetry payload:", error);
    }
  });

  socket.addEventListener("close", () => {
    setWsPhase("disconnected");
    wsConnection = null;
    wsReconnectTimeout = setTimeout(connectWebSocket, WS_RECONNECT_DELAY_MS);
  });

  socket.addEventListener("error", (event) => {
    console.error("WebSocket error:", event);
    socket.close();
  });

  wsConnection = socket;
}

// ==================== Event Binding Helpers ====================
function bindUiEvents() {
  if (refreshButton) {
    refreshButton.addEventListener("click", () => {
      fetchDiagnostics();
      showToast("Diagnostics refreshed", "info");
    });
  }

  if (refreshLogs) {
    refreshLogs.addEventListener("click", () => {
      fetchLogsSnapshot();
      showToast("Logs refreshed", "info");
    });
  }

  if (startForm && startTaskInput && commandOutput) {
    startForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const taskId = startTaskInput.value.trim();
      const command = taskId ? `START ${taskId}` : "START";
      try {
        await sendCommand(command);
        commandOutput.textContent = `✓ START command sent (${taskId || "default"})`;
        showToast(`Task started: ${taskId || "default"}`, "success");
        fetchDiagnostics();
      } catch (error) {
        commandOutput.textContent = `✗ ${error.message}`;
        showToast(error.message, "error");
      }
    });
  }

  if (commandForm && rawCommandInput && commandOutput) {
    commandForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const command = rawCommandInput.value.trim();
      if (!command) {
        showToast("Enter a command", "warning");
        return;
      }
      try {
        const result = await sendCommand(command, false);
        commandOutput.textContent = JSON.stringify(result, null, 2);
        showToast("Command executed", "success");
        fetchDiagnostics();
        switchTab("output");
      } catch (error) {
        commandOutput.textContent = `✗ ${error.message}`;
        showToast(error.message, "error");
        switchTab("output");
      }
    });
  }

  if (brakeButton && commandOutput) {
    brakeButton.addEventListener("click", async () => {
      const confirmed = await showModal(
        "Emergency Stop",
        "This will immediately stop all actuators. Are you sure?"
      );
      if (!confirmed) return;

      try {
        const result = await sendCommand("BRAKE", false);
        commandOutput.textContent = JSON.stringify(result.raw || result, null, 2);
        showToast("BRAKE activated", "warning");
        fetchDiagnostics();
      } catch (error) {
        commandOutput.textContent = `✗ ${error.message}`;
        showToast(`BRAKE failed: ${error.message}`, "error");
      }
    });
  }

  if (modalConfirm) {
    modalConfirm.addEventListener("click", () => hideModal(true));
  }

  if (modalCancel) {
    modalCancel.addEventListener("click", () => hideModal(false));
  }

  if (modalOverlay) {
    modalOverlay.addEventListener("click", (event) => {
      if (event.target === modalOverlay) hideModal(false);
    });
  }

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "b" && brakeButton) {
      event.preventDefault();
      brakeButton.click();
    }
  });

  if (tabButtons && tabButtons.length) {
    tabButtons.forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
  }

  if (clearOutput && commandOutput) {
    clearOutput.addEventListener("click", () => {
      commandOutput.textContent = "";
    });
  }

  if (refreshCamera) {
    refreshCamera.addEventListener("click", () => {
      restartCameraStream(true);
    });
  }

  if (toggleCameraStreamButton) {
    toggleCameraStreamButton.addEventListener("click", () => {
      toggleCameraStreaming();
    });
  }

  if (settingsCameraForm) {
    settingsCameraForm.addEventListener("submit", submitCameraSettings);
  }

  if (settingsCameraRefresh) {
    settingsCameraRefresh.addEventListener("click", () => {
      fetchCameraConfig({ showLoading: true });
    });
  }

  if (settingsCameraQuality) {
    settingsCameraQuality.addEventListener("input", updateCameraQualityDisplayFromControl);
  }

  if (shelfMapForm) {
    shelfMapForm.addEventListener("submit", submitShelfMap);
  }

  if (shelfMapReloadButton) {
    shelfMapReloadButton.addEventListener("click", () => {
      fetchShelfMap({ showLoading: true });
    });
  }

  if (shelfMapResetButton) {
    shelfMapResetButton.addEventListener("click", resetShelfMap);
  }
}

// ==================== Tabs Management ====================
function switchTab(tabName) {
  if (!tabButtons || !tabButtons.length || !tabContents) return;

  activeTabName = tabName;

  tabButtons.forEach((btn) => {
    if (btn.dataset.tab === tabName) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  tabContents.forEach((content) => {
    if (content.dataset.tabContent === tabName) {
      content.classList.add("active");
    } else {
      content.classList.remove("active");
    }
  });

  if (tabName === "camera") {
    cameraStreamDesired = true;
    connectCameraStream();
  } else {
    cameraStreamDesired = false;
    disconnectCameraStream();
  }

  if (tabName === "logs") {
    logStreamDesired = true;
    connectLogStream();
  } else {
    logStreamDesired = false;
    disconnectLogStream();
  }

  if (tabName === "settings") {
    fetchCameraConfig({ showLoading: cameraConfigState === null, silent: cameraConfigState !== null });
    fetchShelfMap({ showLoading: shelfMapState === null, silent: shelfMapState !== null });
  }
}

// ==================== Camera Stream ====================
function showCameraPlaceholder(message) {
  if (!cameraPlaceholder || !cameraFeed) return;
  const textEl = cameraPlaceholder.querySelector("p");
  if (textEl) {
    textEl.textContent = message || cameraPlaceholderDefaultMessage;
  }
  cameraFeed.removeAttribute("src");
  cameraPlaceholder.style.display = "flex";
}

function hideCameraPlaceholder() {
  if (!cameraPlaceholder) return;
  cameraPlaceholder.style.display = "none";
}

function scheduleCameraReconnect(reason) {
  if (!cameraStreamDesired) {
    return;
  }
  if (reason) {
    showCameraPlaceholder(reason);
  }
  if (cameraReconnectTimeout) {
    return;
  }
  cameraReconnectTimeout = setTimeout(() => {
    cameraReconnectTimeout = null;
    connectCameraStream();
  }, CAMERA_WS_RECONNECT_DELAY_MS);
}

function disconnectCameraStream({ clearFrame = false } = {}) {
  if (cameraReconnectTimeout) {
    clearTimeout(cameraReconnectTimeout);
    cameraReconnectTimeout = null;
  }
  if (cameraSocket) {
    try {
      cameraSocket.close();
    } catch (error) {
      console.error("Camera socket close failed:", error);
    }
    cameraSocket = null;
  }
  if (clearFrame) {
    lastCameraErrorMessage = "";
    showCameraPlaceholder();
  }
}

async function toggleCameraStreaming() {
  if (!toggleCameraStreamButton) return;
  if (serviceCameraSource === "override") {
    showToast("Manual snapshot URL override is active. Disable override to use this control.", "warning");
    return;
  }

  const shouldEnable = serviceCameraStreaming !== true;
  const command = `CAMSTREAM ${shouldEnable ? "ON" : "OFF"}`;

  cameraTogglePending = true;
  updateCameraToggleControls();
  showToast(`Sending ${command}...`, "info");

  try {
    await sendCommand(command, true);
    serviceCameraStreaming = shouldEnable;
    handleCameraStreamingStateUpdate();

    showToast(shouldEnable ? "Camera stream enabled" : "Camera stream disabled", "success");

    await fetchServiceInfo();
    await fetchDiagnostics();
  } catch (error) {
    console.error("Failed to toggle camera stream:", error);
    showToast(error.message || "Failed to toggle camera stream", "error");
  } finally {
    cameraTogglePending = false;
    updateCameraToggleControls();
  }
}

function connectCameraStream() {
  if (!cameraFeed || !cameraStreamDesired) return;
  if (cameraSocket && (cameraSocket.readyState === WebSocket.OPEN || cameraSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (serviceCameraStreaming === false && serviceCameraSource !== "override") {
    showCameraPlaceholder("Camera stream disabled. Use Enable Stream above.");
    return;
  }

  if (cameraReconnectTimeout) {
    clearTimeout(cameraReconnectTimeout);
    cameraReconnectTimeout = null;
  }

  showCameraPlaceholder("Connecting to camera…");

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/camera`);

  socket.addEventListener("open", () => {
    // Connection established; wait for first frame.
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "frame" && payload.payload && payload.mime) {
        cameraFeed.src = `data:${payload.mime};base64,${payload.payload}`;
        hideCameraPlaceholder();
        lastCameraErrorMessage = "";
        return;
      }
      if (payload.type === "error" && payload.message) {
        if (payload.message !== lastCameraErrorMessage) {
          showToast(`Camera: ${payload.message}`, "warning");
        }
        lastCameraErrorMessage = payload.message;
        showCameraPlaceholder(payload.message);
      }
    } catch (error) {
      console.error("Camera stream parse error:", error);
    }
  });

  socket.addEventListener("close", () => {
    cameraSocket = null;
    scheduleCameraReconnect();
  });

  socket.addEventListener("error", (event) => {
    console.error("Camera WebSocket error:", event);
    socket.close();
  });

  cameraSocket = socket;
}

function restartCameraStream(showNotification = false) {
  if (!cameraStreamDesired) {
    showToast("Open the Camera tab to start the stream", "info");
    return;
  }
  if (serviceCameraStreaming === false && serviceCameraSource !== "override") {
    showToast("Camera stream is disabled. Use Enable Stream above.", "warning");
    showCameraPlaceholder("Camera stream disabled. Use Enable Stream above.");
    return;
  }
  if (showNotification) {
    showToast("Restarting camera stream…", "info");
  }
  disconnectCameraStream();
  connectCameraStream();
}

// ==================== Initialization ====================
function captureDomReferences() {
  statusGrid = document.getElementById("status-grid");
  refreshButton = document.getElementById("refresh-status");
  refreshCamera = document.getElementById("refresh-camera");
  clearOutput = document.getElementById("clear-output");
  telemetryLegend = document.getElementById("telemetry-legend");
  startForm = document.getElementById("start-form");
  commandForm = document.getElementById("command-form");
  startTaskInput = document.getElementById("start-task");
  rawCommandInput = document.getElementById("raw-command");
  brakeButton = document.getElementById("brake-button");
  commandOutput = document.getElementById("command-output");
  wsStatusEl = document.getElementById("ws-status");
  toastContainer = document.getElementById("toast-container");
  modalOverlay = document.getElementById("modal-overlay");
  modalTitle = document.getElementById("modal-title");
  modalMessage = document.getElementById("modal-message");
  modalConfirm = document.getElementById("modal-confirm");
  modalCancel = document.getElementById("modal-cancel");
  cameraFeed = document.getElementById("camera-feed");
  cameraPlaceholder = document.getElementById("camera-placeholder");
  cameraTransportBadge = document.getElementById("camera-transport-badge");
  toggleCameraStreamButton = document.getElementById("toggle-camera-stream");
  logOutput = document.getElementById("log-output");
  refreshLogs = document.getElementById("refresh-logs");
  settingsCameraForm = document.getElementById("camera-settings-form");
  settingsCameraResolution = document.getElementById("camera-settings-resolution");
  settingsCameraQuality = document.getElementById("camera-settings-quality");
  settingsCameraQualityValue = document.getElementById("camera-settings-quality-value");
  settingsCameraRefresh = document.getElementById("camera-settings-refresh");
  settingsCameraStatus = document.getElementById("camera-settings-status");
  shelfMapForm = document.getElementById("shelf-map-form");
  shelfMapGrid = document.getElementById("shelf-map-grid");
  shelfMapStatus = document.getElementById("shelf-map-status");
  shelfMapReloadButton = document.getElementById("shelf-map-reload");
  shelfMapResetButton = document.getElementById("shelf-map-reset");
  shelfMapPersistCheckbox = document.getElementById("shelf-map-persist");
  tabButtons = document.querySelectorAll(".tab-button");
  tabContents = document.querySelectorAll(".tab-content");

  if (cameraPlaceholder) {
    const textEl = cameraPlaceholder.querySelector("p");
    cameraPlaceholderDefaultMessage = textEl ? textEl.textContent || "" : "";
  }
}

function init() {
  captureDomReferences();
  renderHeaderStatus();
  updateCameraToggleControls();
  updateCameraQualityDisplayFromControl();

  const telemetryCanvas = document.getElementById("telemetry-chart");
  if (!telemetryCanvas) {
    console.error("Telemetry canvas not found; telemetry chart disabled");
  } else {
    chartCtx = telemetryCanvas.getContext("2d");
    if (!chartCtx) {
      console.error("Unable to acquire chart context; telemetry chart disabled");
    } else {
      chart = createChart(chartCtx);
      renderLegend();
    }
  }

  bindUiEvents();

  fetchDiagnostics();
  fetchServiceInfo();
  connectWebSocket();

  if (logOutput) {
    fetchLogsSnapshot();
  }

  diagnosticsRefreshInterval = setInterval(fetchDiagnostics, DIAGNOSTICS_REFRESH_INTERVAL_MS);
  infoRefreshInterval = setInterval(fetchServiceInfo, INFO_REFRESH_INTERVAL_MS);

  const activeTab = Array.from(tabButtons || []).find((btn) => btn.classList.contains("active"));
  if (activeTab) {
    switchTab(activeTab.dataset.tab);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

// Cleanup on unload
window.addEventListener("beforeunload", () => {
  if (wsConnection) wsConnection.close();
  if (diagnosticsRefreshInterval) clearInterval(diagnosticsRefreshInterval);
  if (infoRefreshInterval) clearInterval(infoRefreshInterval);
  if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
  disconnectCameraStream();
  disconnectLogStream();
});
