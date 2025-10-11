import Chart from "chart.js/auto";

const statusGrid = document.getElementById("status-grid");
const refreshButton = document.getElementById("refresh-status");
const telemetryLegend = document.getElementById("telemetry-legend");
const startForm = document.getElementById("start-form");
const commandForm = document.getElementById("command-form");
const startTaskInput = document.getElementById("start-task");
const rawCommandInput = document.getElementById("raw-command");
const raiseOnErrorInput = document.getElementById("raise-on-error");
const brakeButton = document.getElementById("brake-button");
const commandOutput = document.getElementById("command-output");

const METRIC_CONFIG = [
  { key: "elev_mm", label: "Elev (mm)", color: "#20639b" },
  { key: "grip_pos_deg", label: "Grip (deg)", color: "#3caea3" },
  { key: "lineL_adc", label: "Line L", color: "#f6d55c" },
  { key: "lineR_adc", label: "Line R", color: "#ed553b" },
  { key: "vbatt_mV", label: "Vbatt (mV)", color: "#173f5f" },
];

const chartCtx = document.getElementById("telemetry-chart").getContext("2d");
const chart = new Chart(chartCtx, {
  type: "line",
  data: { labels: [], datasets: [] },
  options: {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items) => (items[0] ? items[0].label : ""),
        },
      },
    },
    scales: {
      x: { display: true, title: { display: true, text: "Samples" } },
      y: { display: true, title: { display: true, text: "Value" } },
    },
  },
});

const datasetMap = new Map();

function ensureDataset(metric) {
  if (datasetMap.has(metric.key)) {
    return datasetMap.get(metric.key);
  }
  const dataset = {
    label: metric.label,
    data: [],
    borderColor: metric.color,
    tension: 0.2,
    pointRadius: 0,
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
    badge.style.setProperty("--color", metric.color);
    badge.innerHTML = `<i></i><span>${dataset.label}</span>`;
    telemetryLegend.appendChild(badge);
  });
}

function truncateDatasets() {
  const MAX_POINTS = 120;
  if (chart.data.labels.length > MAX_POINTS) {
    chart.data.labels.splice(0, chart.data.labels.length - MAX_POINTS);
    chart.data.datasets.forEach((dataset) => {
      dataset.data.splice(0, dataset.data.length - MAX_POINTS);
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
  chart.update();
}

async function fetchStatus() {
  try {
    const response = await fetch("/api/status");
    if (!response.ok) {
      throw new Error(`Status request failed: ${response.status}`);
    }
    const payload = await response.json();
    renderStatus(payload.data || {});
  } catch (error) {
    console.error(error);
    commandOutput.textContent = `Status error: ${error.message}`;
  }
}

function renderStatus(data) {
  statusGrid.innerHTML = "";
  const entries = Object.entries(data);
  if (!entries.length) {
    statusGrid.innerHTML = "<p>No structured status available. Check raw CLI output.</p>";
    return;
  }
  entries.forEach(([key, value]) => {
    const card = document.createElement("div");
    card.className = "status-card";
    card.innerHTML = `<h3>${key}</h3><span>${value}</span>`;
    statusGrid.appendChild(card);
  });
}

async function sendCommand(command, raiseOnError = false) {
  const response = await fetch("/api/command", {
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

function handleTelemetryMessage(payload) {
  if (payload.data) {
    pushTelemetrySample(payload.data);
  }
  if (payload.error) {
    commandOutput.textContent = `Telemetry error: ${payload.error}`;
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/telemetry`);

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleTelemetryMessage(payload);
    } catch (error) {
      console.error("Failed to parse telemetry payload", error);
    }
  });

  socket.addEventListener("close", () => {
    setTimeout(connectWebSocket, 2000);
  });

  socket.addEventListener("error", (event) => {
    console.error("WebSocket error", event);
    socket.close();
  });
}

refreshButton.addEventListener("click", () => {
  fetchStatus();
});

startForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const taskId = startTaskInput.value.trim();
  try {
    await sendCommand(taskId ? `START ${taskId}` : "START");
    commandOutput.textContent = `START command sent (${taskId || "default"})`;
  } catch (error) {
    commandOutput.textContent = error.message;
  }
});

commandForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const command = rawCommandInput.value.trim();
  if (!command) {
    commandOutput.textContent = "Enter a command";
    return;
  }
  try {
    const result = await sendCommand(command, raiseOnErrorInput.checked);
    renderStatus(result.data || {});
    commandOutput.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    commandOutput.textContent = `Command error: ${error.message}`;
  }
});

brakeButton.addEventListener("click", async () => {
  if (!confirm("Trigger BRAKE? All actuators will stop.")) {
    return;
  }
  try {
    const result = await sendCommand("BRAKE", false);
    commandOutput.textContent = JSON.stringify(result.raw || result, null, 2);
  } catch (error) {
    commandOutput.textContent = `Brake error: ${error.message}`;
  }
});

fetchStatus();
connectWebSocket();
setInterval(fetchStatus, 10_000);
