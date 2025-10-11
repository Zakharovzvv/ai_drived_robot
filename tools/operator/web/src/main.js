import Chart from "chart.js/auto";

// ==================== Constants ====================
const API_BASE = "";
const WS_RECONNECT_DELAY_MS = 2000;
const STATUS_REFRESH_INTERVAL_MS = 10_000;
const MAX_TELEMETRY_POINTS = 120;
const TOAST_DURATION_MS = 4000;

const METRIC_CONFIG = [
  { key: "elev_mm", label: "Elev (mm)", color: "#20639b" },
  { key: "grip_pos_deg", label: "Grip (deg)", color: "#3caea3" },
  { key: "lineL_adc", label: "Line L", color: "#f6d55c" },
  { key: "lineR_adc", label: "Line R", color: "#ed553b" },
  { key: "vbatt_mV", label: "Vbatt (mV)", color: "#173f5f" },
];

// ==================== DOM Elements ====================
const statusGrid = document.getElementById("status-grid");
const refreshButton = document.getElementById("refresh-status");
const refreshCamera = document.getElementById("refresh-camera");
const clearOutput = document.getElementById("clear-output");
const telemetryLegend = document.getElementById("telemetry-legend");
const startForm = document.getElementById("start-form");
const commandForm = document.getElementById("command-form");
const startTaskInput = document.getElementById("start-task");
const rawCommandInput = document.getElementById("raw-command");
const brakeButton = document.getElementById("brake-button");
const commandOutput = document.getElementById("command-output");
const wsStatusEl = document.getElementById("ws-status");
const toastContainer = document.getElementById("toast-container");
const modalOverlay = document.getElementById("modal-overlay");
const modalTitle = document.getElementById("modal-title");
const modalMessage = document.getElementById("modal-message");
const modalConfirm = document.getElementById("modal-confirm");
const modalCancel = document.getElementById("modal-cancel");
const cameraFeed = document.getElementById("camera-feed");
const cameraPlaceholder = document.getElementById("camera-placeholder");

// Tabs
const tabButtons = document.querySelectorAll(".tab-button");
const tabContents = document.querySelectorAll(".tab-content");

console.log("Tab buttons found:", tabButtons.length);
console.log("Tab contents found:", tabContents.length);

// ==================== State ====================
let wsConnection = null;
let wsReconnectTimeout = null;
let statusRefreshInterval = null;
let modalResolve = null;

// ==================== Chart Setup ====================
const chartCtx = document.getElementById("telemetry-chart").getContext("2d");
const chart = new Chart(chartCtx, {
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

const datasetMap = new Map();

// ==================== Utilities ====================
function updateWSStatus(status) {
  wsStatusEl.className = `status-indicator ${status}`;
  const textMap = {
    connected: "Connected",
    connecting: "Connecting...",
    disconnected: "Disconnected",
  };
  wsStatusEl.querySelector(".status-text").textContent = textMap[status] || status;
}

function showToast(message, type = "info") {
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
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalOverlay.removeAttribute("hidden");
    modalResolve = resolve;
    modalConfirm.focus();
  });
}

function hideModal(result) {
  modalOverlay.setAttribute("hidden", "");
  if (modalResolve) {
    modalResolve(result);
    modalResolve = null;
  }
}

// ==================== Chart Management ====================
function ensureDataset(metric) {
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
  if (chart.data.labels.length > MAX_TELEMETRY_POINTS) {
    const excess = chart.data.labels.length - MAX_TELEMETRY_POINTS;
    chart.data.labels.splice(0, excess);
    chart.data.datasets.forEach((dataset) => {
      dataset.data.splice(0, excess);
    });
  }
}

function pushTelemetrySample(data) {
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
async function fetchStatus() {
  try {
    const response = await fetch(`${API_BASE}/api/status`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const payload = await response.json();
    renderStatus(payload.data || {});
  } catch (error) {
    console.error("Status fetch error:", error);
    showToast(`Failed to fetch status: ${error.message}`, "error");
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

// ==================== Rendering ====================
function renderStatus(data) {
  const entries = Object.entries(data);
  if (!entries.length) {
    statusGrid.innerHTML = '<p style="grid-column: 1/-1; color: var(--color-text-muted); text-align: center;">No status data available</p>';
    return;
  }
  statusGrid.innerHTML = "";
  entries.forEach(([key, value]) => {
    const card = document.createElement("div");
    card.className = "status-card";
    card.innerHTML = `<h3>${key.replace(/_/g, " ")}</h3><span>${value}</span>`;
    statusGrid.appendChild(card);
  });
}

function handleTelemetryMessage(payload) {
  if (payload.data) {
    pushTelemetrySample(payload.data);
  }
  if (payload.error) {
    console.error("Telemetry error:", payload.error);
  }
}

// ==================== WebSocket ====================
function connectWebSocket() {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) return;

  updateWSStatus("connecting");
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/telemetry`);

  socket.addEventListener("open", () => {
    updateWSStatus("connected");
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
    updateWSStatus("disconnected");
    wsConnection = null;
    wsReconnectTimeout = setTimeout(connectWebSocket, WS_RECONNECT_DELAY_MS);
  });

  socket.addEventListener("error", (event) => {
    console.error("WebSocket error:", event);
    socket.close();
  });

  wsConnection = socket;
}

// ==================== Event Listeners ====================
refreshButton.addEventListener("click", () => {
  fetchStatus();
  showToast("Status refreshed", "info");
});

startForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const taskId = startTaskInput.value.trim();
  const command = taskId ? `START ${taskId}` : "START";
  try {
    await sendCommand(command);
    commandOutput.textContent = `✓ START command sent (${taskId || "default"})`;
    showToast(`Task started: ${taskId || "default"}`, "success");
  } catch (error) {
    commandOutput.textContent = `✗ ${error.message}`;
    showToast(error.message, "error");
  }
});

commandForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const command = rawCommandInput.value.trim();
  if (!command) {
    showToast("Enter a command", "warning");
    return;
  }
  try {
    const result = await sendCommand(command, false);
    renderStatus(result.data || {});
    commandOutput.textContent = JSON.stringify(result, null, 2);
    showToast("Command executed", "success");
    
    // Switch to Output tab
    switchTab("output");
  } catch (error) {
    commandOutput.textContent = `✗ ${error.message}`;
    showToast(error.message, "error");
    
    // Switch to Output tab on error
    switchTab("output");
  }
});

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
  } catch (error) {
    commandOutput.textContent = `✗ ${error.message}`;
    showToast(`BRAKE failed: ${error.message}`, "error");
  }
});

modalConfirm.addEventListener("click", () => hideModal(true));
modalCancel.addEventListener("click", () => hideModal(false));
modalOverlay.addEventListener("click", (event) => {
  if (event.target === modalOverlay) hideModal(false);
});

// Keyboard shortcuts
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "b") {
    event.preventDefault();
    brakeButton.click();
  }
});

// ==================== Tabs Management ====================
function switchTab(tabName) {
  console.log("Switching to tab:", tabName);
  
  // Update buttons
  tabButtons.forEach((btn) => {
    if (btn.dataset.tab === tabName) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Update content
  tabContents.forEach((content) => {
    if (content.dataset.tabContent === tabName) {
      content.classList.add("active");
      console.log("Activated content:", tabName);
    } else {
      content.classList.remove("active");
    }
  });

  // Auto-start camera feed when camera tab is active
  if (tabName === "camera") {
    startCameraRefresh();
  } else {
    stopCameraRefresh();
  }
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    console.log("Tab button clicked:", btn.dataset.tab);
    switchTab(btn.dataset.tab);
  });
});

// Clear output button
if (clearOutput) {
  clearOutput.addEventListener("click", () => {
    commandOutput.textContent = "";
  });
}

// ==================== Camera Feed ====================
async function fetchCameraFeed() {
  try {
    const response = await fetch(`${API_BASE}/api/camera/snapshot`);
    if (response.ok) {
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      cameraFeed.src = url;
      cameraPlaceholder.style.display = "none";
    } else {
      cameraFeed.src = "";
      cameraPlaceholder.style.display = "flex";
    }
  } catch (error) {
    console.error("Camera fetch failed:", error);
    cameraFeed.src = "";
    cameraPlaceholder.style.display = "flex";
  }
}

if (refreshCamera) {
  refreshCamera.addEventListener("click", fetchCameraFeed);
}

// Periodic camera refresh (every 500ms when visible)
let cameraRefreshInterval = null;
const startCameraRefresh = () => {
  if (!cameraRefreshInterval) {
    fetchCameraFeed(); // Initial fetch
    cameraRefreshInterval = setInterval(fetchCameraFeed, 500);
  }
};
const stopCameraRefresh = () => {
  if (cameraRefreshInterval) {
    clearInterval(cameraRefreshInterval);
    cameraRefreshInterval = null;
  }
};

// ==================== Initialization ====================
fetchStatus();
connectWebSocket();
statusRefreshInterval = setInterval(fetchStatus, STATUS_REFRESH_INTERVAL_MS);
statusRefreshInterval = setInterval(fetchStatus, STATUS_REFRESH_INTERVAL_MS);

// Cleanup on unload
window.addEventListener("beforeunload", () => {
  if (wsConnection) wsConnection.close();
  if (statusRefreshInterval) clearInterval(statusRefreshInterval);
  if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
});
