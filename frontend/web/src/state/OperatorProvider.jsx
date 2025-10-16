import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  API_BASE,
  CAMERA_WS_RECONNECT_DELAY_MS,
  DIAGNOSTICS_REFRESH_INTERVAL_MS,
  INFO_REFRESH_INTERVAL_MS,
  LOG_MAX_ENTRIES,
  LOG_WS_RECONNECT_DELAY_MS,
  MAX_TELEMETRY_POINTS,
  METRIC_CONFIG,
  TOAST_DURATION_MS,
  TOAST_MAX_VISIBLE,
  WS_RECONNECT_DELAY_MS,
} from "../constants.js";
import { createEmptyShelfGrid, validateShelfGrid } from "../shelfMap.js";
import { DEFAULT_SHELF_PALETTE } from "../constants.js";
import { contrastTextColor } from "../utils/color.js";

const OperatorContext = createContext(null);

const TELEMETRY_WS_PATH = "/ws/telemetry";
const CAMERA_WS_PATH = "/ws/camera";
const LOG_WS_PATH = "/ws/logs";

function withBase(path) {
  return `${API_BASE}${path}`;
}

function buildWsUrl(path) {
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  const protocolFor = (scheme) => (scheme === "https:" ? "wss" : "ws");

  try {
    if (API_BASE && /^https?:/i.test(API_BASE)) {
      const baseUrl = new URL(API_BASE);
      const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname;
      return `${protocolFor(baseUrl.protocol)}://${baseUrl.host}${`${basePath}${trimmedPath}`}`;
    }
  } catch (error) {
    console.warn("Failed to parse API_BASE for WebSocket URL", error);
  }

  const originPrefix = API_BASE && API_BASE.startsWith("/") ? API_BASE.replace(/\/$/, "") : "";
  const protocol = protocolFor(window.location.protocol);
  return `${protocol}://${window.location.host}${originPrefix}${trimmedPath}`;
}

const EMPTY_CONTROL_STATE = Object.freeze({
  mode: "auto",
  active: null,
  endpoint: null,
  transports: [],
});

function normalizeControlState(raw, previous = EMPTY_CONTROL_STATE) {
  const base = previous || EMPTY_CONTROL_STATE;
  if (!raw || typeof raw !== "object") {
    return {
      ...base,
      transports: Array.isArray(base.transports) ? base.transports.map((item) => ({ ...item })) : [],
    };
  }

  const sourceList = Array.isArray(raw.transports)
    ? raw.transports
    : Array.isArray(raw.available_transports)
    ? raw.available_transports
    : Array.isArray(base.transports)
    ? base.transports
    : [];

  const transportsMap = new Map();
  sourceList.forEach((entry) => {
    if (!entry) {
      return;
    }
    const identifier = (entry.id || entry.transport || entry.name || "").toString().trim().toLowerCase();
    if (!identifier) {
      return;
    }
    const labelSource = entry.label || entry.name || entry.id || identifier.toUpperCase();
    const label = typeof labelSource === "string" ? labelSource : identifier.toUpperCase();
    transportsMap.set(identifier, {
      id: identifier,
      label,
      endpoint: entry.endpoint ?? entry.url ?? entry.address ?? null,
      available:
        entry.available !== undefined
          ? Boolean(entry.available)
          : entry.connected !== undefined
          ? Boolean(entry.connected)
          : Boolean(entry.ok),
      last_error: entry.last_error ?? null,
      last_success: entry.last_success ?? null,
      last_failure: entry.last_failure ?? null,
    });
  });

  const transports = Array.from(transportsMap.values());
  const modeRaw = raw.mode ?? raw.control_mode ?? base.mode ?? "auto";
  const mode = modeRaw ? modeRaw.toString().trim().toLowerCase() || "auto" : "auto";
  const activeRaw = raw.active ?? raw.control_transport ?? base.active;
  const active = activeRaw ? activeRaw.toString().trim().toLowerCase() : null;
  const endpoint = raw.endpoint ?? raw.control_endpoint ?? base.endpoint ?? null;

  return {
    mode,
    active,
    endpoint,
    transports,
  };
}

function deriveHeaderStatus(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") {
    return { robotConnected: false, medium: null, ip: null, stale: true };
  }
  const serial = diagnostics.serial || {};
  const wifi = diagnostics.wifi || {};
  const meta = diagnostics.meta || {};
  const statusFresh =
    meta.status_fresh !== undefined
      ? Boolean(meta.status_fresh)
      : Boolean(serial.connected || wifi.connected === true);
  const wifiConnected = statusFresh && wifi.connected === true;
  const serialConnected = statusFresh && serial.connected === true;
  const robotConnected = wifiConnected || serialConnected;
  const medium = wifiConnected ? "wifi" : serialConnected ? "type-c" : null;
  const ip = wifiConnected && typeof wifi.ip === "string" ? wifi.ip : null;
  return { robotConnected, medium, ip, stale: !statusFresh };
}

function extractCameraStateFromDiagnostics(diagnostics) {
  const camera = diagnostics?.camera || {};
  const result = {};
  if (camera.transport !== undefined) result.transport = camera.transport;
  if (camera.snapshot_url !== undefined) result.snapshotUrl = camera.snapshot_url || null;
  if (camera.streaming !== undefined) result.streaming = Boolean(camera.streaming);
  if (camera.source !== undefined) result.source = camera.source;
  if (camera.stream_interval_ms !== undefined) result.streamIntervalMs = camera.stream_interval_ms;
  if (camera.quality !== undefined) result.quality = camera.quality;
  if (camera.resolution !== undefined) result.resolution = camera.resolution;
  if (camera.configured !== undefined) result.configured = Boolean(camera.configured);
  return result;
}

function extractCameraStateFromServiceInfo(info) {
  if (!info) {
    return { transport: null, snapshotUrl: null, streaming: null, source: "auto", error: "Unavailable" };
  }
  return {
    transport: info.camera_transport ?? null,
    snapshotUrl: info.camera_snapshot_url ?? null,
    streaming: info.camera_streaming ?? null,
    source: info.camera_snapshot_source ?? "auto",
    error: null,
  };
}

function normalizeCameraConfig(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const parsedQuality = Number.parseInt(raw.quality, 10);
  const parsedQualityMin = Number.parseInt(raw.quality_min, 10);
  const parsedQualityMax = Number.parseInt(raw.quality_max, 10);
  const normalized = {
    resolution: (raw.resolution || "").toString().toUpperCase() || "UNKNOWN",
    quality: Number.isNaN(parsedQuality) ? null : parsedQuality,
    running: Boolean(raw.running),
    available_resolutions: Array.isArray(raw.available_resolutions) ? raw.available_resolutions : [],
    quality_min: Number.isNaN(parsedQualityMin) ? 10 : parsedQualityMin,
    quality_max: Number.isNaN(parsedQualityMax) ? 63 : parsedQualityMax,
    max_resolution:
      typeof raw.max_resolution === "string" && raw.max_resolution.trim()
        ? raw.max_resolution.trim().toUpperCase()
        : typeof raw.maxResolution === "string" && raw.maxResolution.trim()
        ? raw.maxResolution.trim().toUpperCase()
        : null,
  };
  return normalized;
}

function buildCameraStatusMessage(config) {
  if (!config) return "";
  const streamLabel = config.running ? "Streaming" : "Idle";
  const qualityLabel = config.quality != null ? config.quality : "—";
  const maxLabel = config.max_resolution ? ` • Max ${config.max_resolution}` : "";
  return `Current: ${config.resolution} • Quality ${qualityLabel} • ${streamLabel}${maxLabel}`;
}

function normalizePalette(palette) {
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
    deduped.push({ id, label, color, textColor: contrastTextColor(color) });
  });
  if (!deduped.length) {
    return DEFAULT_SHELF_PALETTE.map((item) => ({ ...item, textColor: contrastTextColor(item.color) }));
  }
  return deduped;
}

function normalizeWifiConfig(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      macAddress: "",
      macPrefix: "",
      ipAddress: "",
      wsPort: null,
      wsPath: "",
      endpoint: null,
      transportAvailable: false,
      autoDiscovery: true,
    };
  }

  const macAddress = typeof raw.mac_address === "string" ? raw.mac_address.trim().toUpperCase() : "";
  const macPrefix = typeof raw.mac_prefix === "string" ? raw.mac_prefix.trim().toUpperCase() : "";
  const ipAddress = typeof raw.ip_address === "string" ? raw.ip_address.trim() : "";
  const rawPort = raw.ws_port ?? raw.port ?? null;
  const parsedPort = Number.parseInt(rawPort, 10);
  const wsPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : null;
  const wsPath = typeof raw.ws_path === "string" ? raw.ws_path.trim() : "";
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : null;
  const transportAvailable = Boolean(raw.transport_available);
  const autoDiscovery = raw.auto_discovery !== undefined ? Boolean(raw.auto_discovery) : true;

  return {
    macAddress,
    macPrefix,
    ipAddress,
    wsPort,
    wsPath,
    endpoint,
    transportAvailable,
    autoDiscovery,
  };
}

function buildWifiStatusMessage(config) {
  if (!config) {
    return "";
  }
  if (config.transportAvailable && config.endpoint) {
    return `Control link ready at ${config.endpoint}`;
  }
  if (config.endpoint) {
    return `Static endpoint configured: ${config.endpoint}`;
  }
  if (config.autoDiscovery) {
    return "Auto-discovery enabled. Waiting for ESP32 broadcast.";
  }
  return "Wi-Fi transport disabled. Clear overrides or provide an ESP32 IP to reconnect.";
}

function deriveControlOverview(state, headerStatus) {
  const transportsSource = Array.isArray(state?.transports) ? state.transports : [];
  const transports = transportsSource.map((entry) => {
    const identifier = entry?.id || entry?.transport || "";
    const id = typeof identifier === "string" ? identifier.trim().toLowerCase() : identifier;
    const rawLabel = entry?.label || entry?.name || entry?.id || identifier;
    const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel : (id ? id.toString().toUpperCase() : "");

    return {
      id: typeof id === "string" ? id : String(id || ""),
      label,
      endpoint: entry?.endpoint ?? entry?.url ?? entry?.address ?? null,
      available: Boolean(entry?.available),
      lastSuccess: entry?.last_success ?? entry?.lastSuccess ?? null,
      lastFailure: entry?.last_failure ?? entry?.lastFailure ?? null,
      lastError: entry?.last_error ?? entry?.lastError ?? null,
    };
  });

  const mode = state?.mode ?? "auto";
  const activeIdRaw = state?.active;
  const activeId = typeof activeIdRaw === "string" ? activeIdRaw.trim().toLowerCase() : activeIdRaw || null;
  const activeTransport = transports.find((item) => item.id === activeId) || null;
  const availableTransports = transports.filter((item) => item.available);
  const primaryTransport = activeTransport?.available ? activeTransport : availableTransports[0] || null;
  const phase = headerStatus?.phase ?? "connecting";

  let status = "offline";
  if (primaryTransport) {
    status = "online";
  } else if (phase === "connecting") {
    status = "connecting";
  }
  if (phase === "disconnected") {
    status = "disconnected";
  }

  return {
    mode,
    activeId,
    activeTransport,
    primaryTransport,
    transports,
    summary: {
      phase,
      status,
      stale: Boolean(headerStatus?.stale),
      transportId: primaryTransport?.id || null,
      transportLabel: primaryTransport?.label || null,
      endpoint: primaryTransport?.endpoint || null,
      availableCount: availableTransports.length,
    },
  };
}

export function OperatorProvider({ children }) {
  const [diagnostics, setDiagnostics] = useState(null);
  const [serviceInfo, setServiceInfo] = useState(null);
  const [headerStatus, setHeaderStatus] = useState({
    phase: "connecting",
    robotConnected: false,
    medium: null,
    ip: null,
    stale: true,
  });
  const [telemetrySamples, setTelemetrySamples] = useState([]);
  const [commandOutput, setCommandOutput] = useState("");
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const isMountedRef = useRef(true);
  const toastTimersRef = useRef(new Map());
  const toastCooldownRef = useRef(new Map());

  const modalResolverRef = useRef(null);
  const [modalState, setModalState] = useState(null);

  const [cameraState, setCameraState] = useState({
    transport: null,
    snapshotUrl: null,
    streaming: null,
    source: "auto",
    error: null,
    configured: false,
    resolution: null,
    quality: null,
    streamIntervalMs: null,
    frame: null,
  });
  const [cameraConfig, setCameraConfig] = useState(null);
  const [cameraConfigStatus, setCameraConfigStatus] = useState({ message: "", tone: "info" });
  const [cameraConfigLoading, setCameraConfigLoading] = useState(false);
  const [cameraConfigUpdating, setCameraConfigUpdating] = useState(false);
  const [cameraTogglePending, setCameraTogglePending] = useState(false);
  const [controlState, setControlState] = useState(EMPTY_CONTROL_STATE);
  const [controlModePending, setControlModePending] = useState(false);
  const [wifiConfig, setWifiConfig] = useState(null);
  const [wifiStatus, setWifiStatus] = useState({ message: "", tone: "info" });
  const [wifiLoading, setWifiLoading] = useState(false);
  const [wifiSaving, setWifiSaving] = useState(false);

  const [shelfMapState, setShelfMapState] = useState(null);
  const [shelfPalette, setShelfPalette] = useState(normalizePalette(DEFAULT_SHELF_PALETTE));
  const [shelfStatus, setShelfStatus] = useState({ message: "", tone: "info" });
  const [shelfBusy, setShelfBusy] = useState(false);

  const telemetrySocketRef = useRef(null);
  const telemetryReconnectRef = useRef(null);
  const lastTelemetryErrorRef = useRef(null);
  const cameraSocketRef = useRef(null);
  const cameraReconnectRef = useRef(null);
  const cameraStreamDesiredRef = useRef(false);
  const logSocketRef = useRef(null);
  const logReconnectRef = useRef(null);
  const [logEntries, setLogEntries] = useState([]);
  const [logFilters, setLogFilters] = useState({ search: "", source: "all", device: "all", parameter: "all" });
  const [logSort, setLogSort] = useState({ column: "timestamp", direction: "desc" });

  useEffect(() => () => {
    isMountedRef.current = false;
    if (telemetrySocketRef.current) telemetrySocketRef.current.close();
    if (telemetryReconnectRef.current) clearTimeout(telemetryReconnectRef.current);
    if (cameraSocketRef.current) cameraSocketRef.current.close();
    if (cameraReconnectRef.current) clearTimeout(cameraReconnectRef.current);
    if (logSocketRef.current) logSocketRef.current.close();
    if (logReconnectRef.current) clearTimeout(logReconnectRef.current);
  }, []);

  const clearToastTimer = useCallback((id) => {
    const timers = toastTimersRef.current;
    const timerId = timers.get(id);
    if (timerId) {
      window.clearTimeout(timerId);
      timers.delete(id);
    }
  }, []);

  const removeToast = useCallback(
    (id) => {
      clearToastTimer(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    },
    [clearToastTimer]
  );

  const showToast = useCallback(
    (message, tone = "info") => {
      const key = `${tone}:${message}`;
      const now = Date.now();
      let createdToastId = null;

      setToasts((prev) => {
        const hasSameToast = prev.some((toast) => toast.message === message && toast.tone === tone);
        if (hasSameToast) {
          return prev;
        }

        const lastShownAt = toastCooldownRef.current.get(key) ?? 0;
        if (now - lastShownAt < TOAST_DURATION_MS) {
          return prev;
        }

        toastCooldownRef.current.set(key, now);
        toastIdRef.current += 1;
        createdToastId = toastIdRef.current;
        const expiresAt = now + TOAST_DURATION_MS;

        const next = prev.length ? [...prev] : [];
        next.push({ id: createdToastId, message, tone, expiresAt });
        if (next.length > TOAST_MAX_VISIBLE) {
          const overflow = next.length - TOAST_MAX_VISIBLE;
          const removed = next.splice(0, overflow);
          removed.forEach((toast) => clearToastTimer(toast.id));
        }
        return next;
      });

      if (createdToastId === null) {
        return null;
      }

      const timerId = window.setTimeout(() => {
        if (!isMountedRef.current) {
          return;
        }
        clearToastTimer(createdToastId);
        setToasts((prev) => prev.filter((toast) => toast.id !== createdToastId));
      }, TOAST_DURATION_MS);
      toastTimersRef.current.set(createdToastId, timerId);
      return createdToastId;
    },
    [clearToastTimer]
  );

  useEffect(() => {
    return () => {
      toastTimersRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      toastTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!toasts.length) {
      return undefined;
    }

    const now = Date.now();
    const nextExpiry = toasts.reduce((soonest, toast) => {
      if (!toast.expiresAt) {
        return soonest;
      }
      return Math.min(soonest, toast.expiresAt);
    }, Number.POSITIVE_INFINITY);

    if (!Number.isFinite(nextExpiry)) {
      return undefined;
    }

    const handleSweep = () => {
      const cutoff = Date.now();
      setToasts((prev) => {
        let mutated = false;
        const filtered = prev.filter((toast) => {
          if (!toast.expiresAt || toast.expiresAt > cutoff) {
            return true;
          }
          clearToastTimer(toast.id);
          mutated = true;
          return false;
        });
        return mutated ? filtered : prev;
      });
    };

    const delay = Math.max(0, nextExpiry - now + 25);
    const sweepId = window.setTimeout(handleSweep, delay);
    return () => window.clearTimeout(sweepId);
  }, [toasts, clearToastTimer]);

  const confirm = useCallback((title, message) => {
    return new Promise((resolve) => {
      modalResolverRef.current = resolve;
      setModalState({ title, message });
    });
  }, []);

  const resolveModal = useCallback((result) => {
    const resolver = modalResolverRef.current;
    modalResolverRef.current = null;
    setModalState(null);
    if (resolver) {
      resolver(result);
    }
  }, []);

  const requestJson = useCallback(async (path, options = {}) => {
    const response = await fetch(withBase(path), options);
    if (!response.ok) {
      let detail = response.statusText;
      try {
        const payload = await response.json();
        detail = payload.detail || payload.error || detail;
      } catch (error) {
        // ignore JSON parse errors
      }
      const error = new Error(detail || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }, []);

  const addTelemetrySample = useCallback((data) => {
    if (!data || typeof data !== "object") {
      return;
    }
    const timestamp = Date.now();
    const normalized = {};
    METRIC_CONFIG.forEach((metric) => {
      normalized[metric.key] = data[metric.key] ?? null;
    });
    setTelemetrySamples((prev) => {
      const next = [...prev, { timestamp, data: normalized }];
      if (next.length > MAX_TELEMETRY_POINTS) {
        next.splice(0, next.length - MAX_TELEMETRY_POINTS);
      }
      return next;
    });
  }, []);

  const updateCameraState = useCallback((patch) => {
    setCameraState((prev) => ({ ...prev, ...patch }));
  }, []);

  const fetchDiagnostics = useCallback(async () => {
    try {
      const payload = await requestJson("/api/diagnostics");
      setDiagnostics(payload);
      const header = deriveHeaderStatus(payload);
      setHeaderStatus((prev) => ({ ...prev, ...header }));
      const cameraPatch = extractCameraStateFromDiagnostics(payload);
      if (Object.keys(cameraPatch).length) {
        updateCameraState(cameraPatch);
      }
      return payload;
    } catch (error) {
      console.error("Diagnostics fetch error:", error);
      showToast(`Failed to fetch diagnostics: ${error.message}`, "error");
      setHeaderStatus((prev) => ({ ...prev, robotConnected: false, medium: null, ip: null, stale: true }));
      throw error;
    }
  }, [requestJson, showToast, updateCameraState]);

  const fetchServiceInfo = useCallback(async () => {
    try {
      const payload = await requestJson("/api/info");
      setServiceInfo(payload);
      setControlState((previous) =>
        normalizeControlState(
          {
            mode: payload?.control_mode,
            active: payload?.control_transport,
            endpoint: payload?.control_endpoint,
            transports: payload?.available_transports,
          },
          previous
        )
      );
      const cameraPatch = extractCameraStateFromServiceInfo(payload);
      updateCameraState(cameraPatch);
      return payload;
    } catch (error) {
      console.error("Service info fetch error:", error);
      updateCameraState({ error: error.message || "Unavailable", streaming: null, snapshotUrl: null });
      return null;
    }
  }, [requestJson, updateCameraState]);

  const fetchControlState = useCallback(
    async ({ silent = false } = {}) => {
      try {
        const payload = await requestJson("/api/control/transport");
        setControlState((previous) => normalizeControlState(payload, previous));
        return payload;
      } catch (error) {
        console.error("Control transport fetch error:", error);
        if (!silent) {
          showToast(error.message || "Failed to load control transport state", "error");
        }
        throw error;
      }
    },
    [requestJson, showToast]
  );

  const changeControlTransport = useCallback(
    async (mode, { silent = false } = {}) => {
      if (!mode && mode !== "") {
        return null;
      }
      const normalizedMode = mode.toString().trim().toLowerCase();
      setControlModePending(true);
      try {
        const payload = await requestJson("/api/control/transport", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: normalizedMode }),
        });
        let computedState = null;
        setControlState((previous) => {
          const nextState = normalizeControlState(payload, previous);
          computedState = nextState;
          return nextState;
        });
        await Promise.allSettled([
          fetchServiceInfo(),
          fetchControlState({ silent: true }),
          fetchDiagnostics(),
        ]);
        if (!silent && computedState) {
          const activeLabel =
            computedState.mode === "auto"
              ? "Auto (Wi-Fi -> UART)"
              : computedState.transports.find((entry) => entry.id === computedState.mode)?.label ||
                computedState.mode.toUpperCase();
          showToast(`Control link set to ${activeLabel}`, "success");
        }
        return computedState;
      } catch (error) {
        console.error("Failed to change control transport:", error);
        if (!silent) {
          showToast(error.message || "Failed to update control link", "error");
        }
        throw error;
      } finally {
        setControlModePending(false);
      }
    },
    [requestJson, fetchServiceInfo, fetchControlState, fetchDiagnostics, showToast]
  );

  const loadWifiConfig = useCallback(
    async ({ silent = false } = {}) => {
      if (wifiLoading) {
        return wifiConfig;
      }
      setWifiLoading(true);
      if (!silent) {
        setWifiStatus({ message: "Loading Wi-Fi settings…", tone: "info" });
      }
      try {
        const payload = await requestJson("/api/control/wifi");
        const normalized = normalizeWifiConfig(payload);
        setWifiConfig(normalized);
        const message = buildWifiStatusMessage(normalized);
        const tone = normalized.transportAvailable ? "success" : "info";
        setWifiStatus({ message, tone });
        if (!silent) {
          showToast("Wi-Fi settings refreshed", "success");
        }
        return normalized;
      } catch (error) {
        console.error("Failed to fetch Wi-Fi settings:", error);
        setWifiStatus({ message: error.message || "Failed to load Wi-Fi settings", tone: "error" });
        if (!silent) {
          showToast(error.message || "Failed to load Wi-Fi settings", "error");
        }
        throw error;
      } finally {
        setWifiLoading(false);
      }
    },
    [wifiLoading, wifiConfig, requestJson, showToast]
  );

  const applyWifiConfig = useCallback(
    async (changes = {}, { silent = false } = {}) => {
      if (!changes || typeof changes !== "object") {
        return wifiConfig;
      }

      const payload = {};
      if (Object.prototype.hasOwnProperty.call(changes, "macAddress")) {
        const text = changes.macAddress == null ? null : String(changes.macAddress).trim().toUpperCase();
        payload.mac_address = text || null;
      }
      if (Object.prototype.hasOwnProperty.call(changes, "macPrefix")) {
        const text = changes.macPrefix == null ? null : String(changes.macPrefix).trim().toUpperCase();
        payload.mac_prefix = text || null;
      }
      if (Object.prototype.hasOwnProperty.call(changes, "ipAddress")) {
        const text = changes.ipAddress == null ? null : String(changes.ipAddress).trim();
        payload.ip_address = text || null;
      }
      if (Object.prototype.hasOwnProperty.call(changes, "wsPort")) {
        if (changes.wsPort === null || changes.wsPort === "") {
          payload.ws_port = null;
        } else {
          const parsed = Number.parseInt(changes.wsPort, 10);
          payload.ws_port = Number.isFinite(parsed) ? parsed : changes.wsPort;
        }
      }
      if (Object.prototype.hasOwnProperty.call(changes, "wsPath")) {
        if (changes.wsPath == null) {
          payload.ws_path = null;
        } else {
          const text = String(changes.wsPath).trim();
          payload.ws_path = text ? (text.startsWith("/") ? text : `/${text}`) : null;
        }
      }

      if (!Object.keys(payload).length) {
        const message = buildWifiStatusMessage(wifiConfig);
        const tone = wifiConfig?.transportAvailable ? "success" : "info";
        setWifiStatus({ message, tone });
        if (!silent) {
          showToast("No Wi-Fi changes detected", "info");
        }
        return wifiConfig;
      }

      setWifiSaving(true);
      setWifiStatus({ message: "Applying Wi-Fi settings…", tone: "info" });
      try {
        const response = await requestJson("/api/control/wifi", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const normalized = normalizeWifiConfig(response);
        setWifiConfig(normalized);
        const message = buildWifiStatusMessage(normalized);
        const tone = normalized.transportAvailable ? "success" : "info";
        setWifiStatus({ message, tone });
        if (!silent) {
          showToast("Wi-Fi settings updated", "success");
        }
        await Promise.allSettled([
          fetchServiceInfo(),
          fetchControlState({ silent: true }),
          fetchDiagnostics(),
        ]);
        return normalized;
      } catch (error) {
        console.error("Failed to update Wi-Fi settings:", error);
        setWifiStatus({ message: error.message || "Failed to update Wi-Fi settings", tone: "error" });
        if (!silent) {
          showToast(error.message || "Failed to update Wi-Fi settings", "error");
        }
        throw error;
      } finally {
        setWifiSaving(false);
      }
    },
    [wifiConfig, requestJson, showToast, fetchServiceInfo, fetchControlState, fetchDiagnostics]
  );

  const sendCommand = useCallback(
    async (command, raiseOnError = false) => {
      return requestJson("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, raise_on_error: raiseOnError }),
      });
    },
    [requestJson]
  );

  const startTask = useCallback(
    async (taskId) => {
      const command = taskId ? `START ${taskId}` : "START";
      try {
        await sendCommand(command);
        setCommandOutput(`\u2713 START command sent (${taskId || "default"})`);
        showToast(`Task started: ${taskId || "default"}`, "success");
        fetchDiagnostics();
      } catch (error) {
        setCommandOutput(`\u2717 ${error.message}`);
        showToast(error.message, "error");
        throw error;
      }
    },
    [sendCommand, showToast, fetchDiagnostics]
  );

  const executeRawCommand = useCallback(
    async (command) => {
      try {
        const result = await sendCommand(command, false);
        setCommandOutput(JSON.stringify(result, null, 2));
        showToast("Command executed", "success");
        fetchDiagnostics();
        return result;
      } catch (error) {
        setCommandOutput(`\u2717 ${error.message}`);
        showToast(error.message, "error");
        throw error;
      }
    },
    [sendCommand, showToast, fetchDiagnostics]
  );

  const brake = useCallback(async () => {
    try {
      const result = await sendCommand("BRAKE", false);
      const payload = result?.raw || result;
      setCommandOutput(JSON.stringify(payload, null, 2));
      showToast("BRAKE activated", "warning");
      fetchDiagnostics();
      return payload;
    } catch (error) {
      setCommandOutput(`\u2717 ${error.message}`);
      showToast(`BRAKE failed: ${error.message}`, "error");
      throw error;
    }
  }, [sendCommand, showToast, fetchDiagnostics]);

  const clearCommandOutput = useCallback(() => {
    setCommandOutput("");
  }, []);

  const loadCameraConfig = useCallback(
    async ({ silent = false } = {}) => {
      if (cameraConfigLoading) {
        return cameraConfig;
      }
      setCameraConfigLoading(true);
      if (!silent) {
        setCameraConfigStatus({ message: "Loading camera configuration…", tone: "info" });
      }
      try {
        const payload = await requestJson("/api/camera/config");
        const normalized = normalizeCameraConfig(payload);
        setCameraConfig(normalized);
        const message = buildCameraStatusMessage(normalized);
        setCameraConfigStatus({ message, tone: normalized?.running ? "success" : "info" });
        if (!silent) {
          showToast("Camera settings refreshed", "success");
        }
        return normalized;
      } catch (error) {
        console.error("Failed to fetch camera settings:", error);
        if (!silent) {
          setCameraConfigStatus({ message: error.message || "Failed to load camera settings", tone: "error" });
          showToast(`Failed to fetch camera settings: ${error.message}`, "error");
        }
        throw error;
      } finally {
        setCameraConfigLoading(false);
      }
    },
    [cameraConfigLoading, cameraConfig, requestJson, showToast]
  );

  const applyCameraConfig = useCallback(
    async (changes) => {
      if (!changes || typeof changes !== "object" || !Object.keys(changes).length) {
        setCameraConfigStatus({ message: "No changes to apply.", tone: "info" });
        showToast("No camera settings changes detected", "info");
        return cameraConfig;
      }
      setCameraConfigUpdating(true);
      setCameraConfigStatus({ message: "Applying camera settings…", tone: "info" });
      try {
        const payload = await requestJson("/api/camera/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(changes),
        });
        const normalized = normalizeCameraConfig(payload);
        setCameraConfig(normalized);
        setCameraConfigStatus({ message: "Camera settings updated", tone: "success" });
        showToast("Camera settings updated", "success");
        await Promise.allSettled([fetchServiceInfo(), fetchDiagnostics()]);
        return normalized;
      } catch (error) {
        console.error("Failed to update camera settings:", error);
        setCameraConfigStatus({ message: error.message || "Failed to update camera settings", tone: "error" });
        showToast(error.message || "Failed to update camera settings", "error");
        throw error;
      } finally {
        setCameraConfigUpdating(false);
      }
    },
    [requestJson, showToast, fetchServiceInfo, fetchDiagnostics, cameraConfig]
  );

  const reloadShelfMap = useCallback(
    async ({ silent = false } = {}) => {
      if (shelfBusy) {
        return shelfMapState;
      }
      setShelfBusy(true);
      if (!silent) {
        setShelfStatus({ message: "Loading shelf map…", tone: "info" });
      }
      try {
        const payload = await requestJson("/api/shelf-map");
        const palette = normalizePalette(payload.palette);
        setShelfPalette(palette);
        const grid = validateShelfGrid(payload.grid || createEmptyShelfGrid(), palette.map((entry) => entry.id));
        const enriched = { ...payload, grid, palette };
        setShelfMapState(enriched);
        if (!silent) {
          setShelfStatus({ message: "Shelf map loaded", tone: "success" });
          showToast("Shelf map loaded", "success");
        }
        return enriched;
      } catch (error) {
        console.error("Failed to fetch shelf map:", error);
        setShelfStatus({ message: error.message || "Failed to load shelf map", tone: "error" });
        if (!silent) {
          showToast(`Failed to load shelf map: ${error.message}`, "error");
        }
        throw error;
      } finally {
        setShelfBusy(false);
      }
    },
    [requestJson, shelfBusy, shelfMapState, showToast]
  );

  const updateShelfMap = useCallback(
    async ({ grid, persist }) => {
      setShelfBusy(true);
      setShelfStatus({ message: "Applying shelf map…", tone: "info" });
      try {
        const payload = await requestJson("/api/shelf-map", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grid, persist }),
        });
        const palette = normalizePalette(payload.palette);
        setShelfPalette(palette);
        const normalizedGrid = validateShelfGrid(payload.grid || grid, palette.map((entry) => entry.id));
        const enriched = { ...payload, grid: normalizedGrid, palette };
        setShelfMapState(enriched);
        const message = persist ? "Shelf map saved to flash" : "Shelf map updated";
        setShelfStatus({ message, tone: "success" });
        showToast(message, "success");
        await Promise.allSettled([fetchDiagnostics(), fetchServiceInfo()]);
        return enriched;
      } catch (error) {
        console.error("Failed to update shelf map:", error);
        setShelfStatus({ message: error.message || "Failed to update shelf map", tone: "error" });
        showToast(error.message || "Failed to update shelf map", "error");
        throw error;
      } finally {
        setShelfBusy(false);
      }
    },
    [requestJson, showToast, fetchDiagnostics, fetchServiceInfo]
  );

  const resetShelfMap = useCallback(
    async ({ persist }) => {
      setShelfBusy(true);
      setShelfStatus({ message: "Resetting shelf map…", tone: "info" });
      try {
        const payload = await requestJson("/api/shelf-map/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ persist }),
        });
        const palette = normalizePalette(payload.palette);
        setShelfPalette(palette);
        const normalizedGrid = validateShelfGrid(payload.grid || createEmptyShelfGrid(), palette.map((entry) => entry.id));
        const enriched = { ...payload, grid: normalizedGrid, palette };
        setShelfMapState(enriched);
        const message = persist
          ? "Shelf map reset and saved to flash"
          : "Shelf map reset to firmware defaults";
        setShelfStatus({ message, tone: "success" });
        showToast(message, "success");
        await Promise.allSettled([fetchDiagnostics(), fetchServiceInfo()]);
        return enriched;
      } catch (error) {
        console.error("Failed to reset shelf map:", error);
        setShelfStatus({ message: error.message || "Failed to reset shelf map", tone: "error" });
        showToast(error.message || "Failed to reset shelf map", "error");
        throw error;
      } finally {
        setShelfBusy(false);
      }
    },
    [requestJson, showToast, fetchDiagnostics, fetchServiceInfo]
  );

  const cameraSource = cameraState.source;
  const cameraStreaming = cameraState.streaming;

  const toggleCameraStreaming = useCallback(async () => {
    if (cameraSource === "override") {
      showToast("Manual snapshot URL override is active. Disable override to use this control.", "warning");
      return;
    }
    const shouldEnable = cameraStreaming !== true;
    const command = `CAMSTREAM ${shouldEnable ? "ON" : "OFF"}`;
    setCameraTogglePending(true);
    showToast(`Sending ${command}...`, "info");
    try {
      await sendCommand(command, true);
      updateCameraState({ streaming: shouldEnable, error: null });
      showToast(shouldEnable ? "Camera stream enabled" : "Camera stream disabled", "success");
      await Promise.allSettled([fetchServiceInfo(), fetchDiagnostics()]);
    } catch (error) {
      console.error("Failed to toggle camera stream:", error);
      showToast(error.message || "Failed to toggle camera stream", "error");
      throw error;
    } finally {
      setCameraTogglePending(false);
    }
  }, [cameraSource, cameraStreaming, sendCommand, showToast, updateCameraState, fetchServiceInfo, fetchDiagnostics]);

  const restartCameraStream = useCallback(
    (showNotification = false) => {
      if (!cameraStreamDesiredRef.current) {
        showToast("Open the Camera tab to start the stream", "info");
        return;
      }
      if (cameraState.source !== "override" && cameraState.streaming === false) {
        showToast("Camera stream is disabled. Use Enable Stream above.", "warning");
        return;
      }
      if (showNotification) {
        showToast("Restarting camera stream…", "info");
      }
      if (cameraSocketRef.current) {
        try {
          cameraSocketRef.current.close();
        } catch (error) {
          console.error("Failed to close camera socket", error);
        }
      }
    },
    [cameraState.source, cameraState.streaming, showToast]
  );

  const connectTelemetrySocket = useCallback(() => {
    if (telemetrySocketRef.current) {
      return;
    }
    setHeaderStatus((prev) => ({ ...prev, phase: "connecting" }));
    const socket = new WebSocket(buildWsUrl(TELEMETRY_WS_PATH));
    telemetrySocketRef.current = socket;
    socket.addEventListener("open", () => {
      setHeaderStatus((prev) => ({ ...prev, phase: "ready" }));
      showToast("WebSocket connected", "success");
    });
    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.data) {
          addTelemetrySample(payload.data);
        }
        if (payload.error) {
          if (lastTelemetryErrorRef.current !== payload.error) {
            lastTelemetryErrorRef.current = payload.error;
            showToast(`Robot offline: ${payload.error}`, "warning");
          }
          setHeaderStatus((prev) => ({ ...prev, robotConnected: false, medium: null, ip: null, stale: true }));
          return;
        }
        if (lastTelemetryErrorRef.current) {
          lastTelemetryErrorRef.current = null;
        }
      } catch (error) {
        console.error("Telemetry parse error:", error);
      }
    });
    socket.addEventListener("close", () => {
      telemetrySocketRef.current = null;
      lastTelemetryErrorRef.current = null;
      setHeaderStatus((prev) => ({ ...prev, phase: "disconnected" }));
      telemetryReconnectRef.current = window.setTimeout(() => {
        telemetryReconnectRef.current = null;
        connectTelemetrySocket();
      }, WS_RECONNECT_DELAY_MS);
    });
    socket.addEventListener("error", (event) => {
      console.warn("Telemetry WebSocket error", event);
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    });
  }, [addTelemetrySample, showToast]);

  const connectCameraSocket = useCallback(() => {
    if (cameraSocketRef.current || !cameraStreamDesiredRef.current) {
      return;
    }
    if (cameraState.source !== "override" && cameraState.streaming === false) {
      updateCameraState({ error: "Camera stream disabled. Use Enable Stream above." });
      return;
    }
    updateCameraState({ error: cameraState.error === "Camera stream disabled. Use Enable Stream above." ? null : cameraState.error });
    const socket = new WebSocket(buildWsUrl(CAMERA_WS_PATH));
    cameraSocketRef.current = socket;
    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "frame" && payload.payload && payload.mime) {
          updateCameraState({ frame: `data:${payload.mime};base64,${payload.payload}`, error: null });
        } else if (payload.type === "error" && payload.message) {
          updateCameraState({ error: payload.message });
          showToast(`Camera: ${payload.message}`, "warning");
        }
      } catch (error) {
        console.error("Camera stream parse error:", error);
      }
    });
    socket.addEventListener("close", () => {
      cameraSocketRef.current = null;
      if (!cameraStreamDesiredRef.current) {
        return;
      }
      cameraReconnectRef.current = window.setTimeout(() => {
        cameraReconnectRef.current = null;
        connectCameraSocket();
      }, CAMERA_WS_RECONNECT_DELAY_MS);
    });
    socket.addEventListener("error", (event) => {
      console.error("Camera WebSocket error:", event);
      socket.close();
    });
  }, [cameraState.source, cameraState.streaming, cameraState.error, showToast, updateCameraState]);

  const disconnectCameraSocket = useCallback(() => {
    cameraStreamDesiredRef.current = false;
    if (cameraReconnectRef.current) {
      clearTimeout(cameraReconnectRef.current);
      cameraReconnectRef.current = null;
    }
    if (cameraSocketRef.current) {
      try {
        cameraSocketRef.current.close();
      } catch (error) {
        console.error("Error closing camera WebSocket:", error);
      }
      cameraSocketRef.current = null;
    }
    updateCameraState({ frame: null });
  }, [updateCameraState]);

  const ensureCameraStream = useCallback(() => {
    cameraStreamDesiredRef.current = true;
    if (cameraReconnectRef.current) {
      clearTimeout(cameraReconnectRef.current);
      cameraReconnectRef.current = null;
    }
    connectCameraSocket();
  }, [connectCameraSocket]);

  const connectLogSocket = useCallback(() => {
    if (logSocketRef.current) {
      return;
    }
    const socket = new WebSocket(buildWsUrl(LOG_WS_PATH));
    logSocketRef.current = socket;
    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (Array.isArray(payload.entries)) {
          setLogEntries((prev) => {
            const map = new Map(prev.map((entry) => [entry.id, entry]));
            payload.entries.forEach((entry) => {
              if (entry && entry.id) {
                map.set(entry.id, entry);
              }
            });
            const merged = Array.from(map.values());
            merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
            if (merged.length > 0) {
              const excess = merged.length - LOG_MAX_ENTRIES;
              if (excess > 0) {
                merged.splice(0, excess);
              }
            }
            return merged;
          });
        } else if (payload && payload.id) {
          setLogEntries((prev) => {
            const next = [...prev, payload];
            if (next.length > LOG_MAX_ENTRIES) {
              next.splice(0, next.length - LOG_MAX_ENTRIES);
            }
            return next;
          });
        }
      } catch (error) {
        console.error("Log stream parse error:", error);
      }
    });
    socket.addEventListener("close", () => {
      logSocketRef.current = null;
      logReconnectRef.current = window.setTimeout(() => {
        logReconnectRef.current = null;
        connectLogSocket();
      }, LOG_WS_RECONNECT_DELAY_MS);
    });
    socket.addEventListener("error", (event) => {
      console.error("Log WebSocket error:", event);
      socket.close();
    });
  }, []);

  const disconnectLogSocket = useCallback(() => {
    if (logReconnectRef.current) {
      clearTimeout(logReconnectRef.current);
      logReconnectRef.current = null;
    }
    if (logSocketRef.current) {
      try {
        logSocketRef.current.close();
      } catch (error) {
        console.error("Error closing log WebSocket:", error);
      }
      logSocketRef.current = null;
    }
  }, []);

  const fetchLogsSnapshot = useCallback(
    async ({ limit = 200 } = {}) => {
      const payload = await requestJson(`/api/logs?limit=${limit}`);
      if (Array.isArray(payload?.entries)) {
        setLogEntries(payload.entries);
      }
      return payload;
    },
    [requestJson]
  );

  useEffect(() => {
    fetchDiagnostics();
    fetchServiceInfo();
    fetchControlState({ silent: true }).catch(() => {});
    connectTelemetrySocket();
    const diagInterval = window.setInterval(fetchDiagnostics, DIAGNOSTICS_REFRESH_INTERVAL_MS);
    const infoInterval = window.setInterval(fetchServiceInfo, INFO_REFRESH_INTERVAL_MS);
    const controlInterval = window.setInterval(() => {
      fetchControlState({ silent: true }).catch(() => {});
    }, INFO_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(diagInterval);
      window.clearInterval(infoInterval);
      window.clearInterval(controlInterval);
    };
  }, [fetchDiagnostics, fetchServiceInfo, fetchControlState, connectTelemetrySocket]);

  const filteredLogs = useMemo(() => {
    const search = logFilters.search.trim().toLowerCase();
    const sourceFilter = logFilters.source;
    const deviceFilter = logFilters.device;
    const parameterFilter = logFilters.parameter;
    const sorted = [...logEntries].filter((entry) => {
      if (!entry) return false;
      if (sourceFilter !== "all" && entry.source !== sourceFilter) return false;
      if (deviceFilter !== "all" && entry.device !== deviceFilter) return false;
      if (parameterFilter !== "all" && entry.parameter !== parameterFilter) return false;
      if (search) {
        const haystack = `${entry.timestamp ?? ""} ${entry.source ?? ""} ${entry.device ?? ""} ${entry.parameter ?? ""} ${entry.value ?? ""} ${entry.raw ?? ""}`.toLowerCase();
        if (!haystack.includes(search)) {
          return false;
        }
      }
      return true;
    });
    const direction = logSort.direction === "asc" ? 1 : -1;
    sorted.sort((a, b) => {
      const key = logSort.column;
      const left = a[key];
      const right = b[key];
      if (left === right) return 0;
      if (left == null) return -1 * direction;
      if (right == null) return 1 * direction;
      if (left < right) return -1 * direction;
      if (left > right) return 1 * direction;
      return 0;
    });
    return sorted;
  }, [logEntries, logFilters, logSort]);

  const controlOverview = useMemo(() => deriveControlOverview(controlState, headerStatus), [controlState, headerStatus]);

  const contextValue = useMemo(
    () => ({
      diagnostics,
      serviceInfo,
      headerStatus,
      controlState,
      controlOverview,
      controlModePending,
      wifiConfig,
      wifiStatus,
      wifiLoading,
      wifiSaving,
      telemetrySamples,
      commandOutput,
      toasts,
      showToast,
      removeToast,
      confirm,
      resolveModal,
      modalState,
      fetchDiagnostics,
      fetchServiceInfo,
      fetchControlState,
      changeControlTransport,
      loadWifiConfig,
      applyWifiConfig,
      startTask,
      executeRawCommand,
      brake,
      clearCommandOutput,
      cameraState,
      cameraConfig,
      cameraConfigStatus,
      cameraConfigLoading,
      cameraConfigUpdating,
      loadCameraConfig,
      applyCameraConfig,
      toggleCameraStreaming,
      cameraTogglePending,
      restartCameraStream,
      ensureCameraStream,
      disconnectCameraSocket,
      shelfMapState,
      shelfPalette,
      shelfStatus,
      shelfBusy,
      reloadShelfMap,
      updateShelfMap,
      resetShelfMap,
      connectLogSocket,
      disconnectLogSocket,
      fetchLogsSnapshot,
      logEntries: filteredLogs,
      setLogFilters,
      logFilters,
      setLogSort,
      logSort,
    }),
    [
      diagnostics,
      serviceInfo,
      headerStatus,
      controlState,
      controlOverview,
      controlModePending,
      wifiConfig,
      wifiStatus,
      wifiLoading,
      wifiSaving,
      telemetrySamples,
      commandOutput,
      toasts,
      showToast,
      removeToast,
      confirm,
      resolveModal,
      modalState,
      fetchDiagnostics,
      fetchServiceInfo,
      fetchControlState,
      changeControlTransport,
      loadWifiConfig,
      applyWifiConfig,
      startTask,
      executeRawCommand,
      brake,
      clearCommandOutput,
      cameraState,
      cameraConfig,
      cameraConfigStatus,
      cameraConfigLoading,
      cameraConfigUpdating,
      loadCameraConfig,
      applyCameraConfig,
      toggleCameraStreaming,
      cameraTogglePending,
      restartCameraStream,
      ensureCameraStream,
      disconnectCameraSocket,
      shelfMapState,
      shelfPalette,
      shelfStatus,
      shelfBusy,
      reloadShelfMap,
      updateShelfMap,
      resetShelfMap,
      connectLogSocket,
      disconnectLogSocket,
      fetchLogsSnapshot,
      filteredLogs,
      setLogFilters,
      logFilters,
      setLogSort,
      logSort,
    ]
  );

  return <OperatorContext.Provider value={contextValue}>{children}</OperatorContext.Provider>;
}

export function useOperator() {
  const context = useContext(OperatorContext);
  if (!context) {
    throw new Error("useOperator must be used within an OperatorProvider");
  }
  return context;
}
