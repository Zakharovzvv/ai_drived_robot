export const API_BASE = "";

export const WS_RECONNECT_DELAY_MS = 2000;
export const DIAGNOSTICS_REFRESH_INTERVAL_MS = 10_000;
export const INFO_REFRESH_INTERVAL_MS = 30_000;
export const CAMERA_WS_RECONNECT_DELAY_MS = 3000;
export const LOG_WS_RECONNECT_DELAY_MS = 3000;
export const MAX_TELEMETRY_POINTS = 120;
export const LOG_MAX_ENTRIES = 600;
export const TOAST_DURATION_MS = 5000;
export const TOAST_MAX_VISIBLE = 4;

export const METRIC_CONFIG = [
  { key: "elev_mm", label: "Elev (mm)", color: "#20639b" },
  { key: "grip_pos_deg", label: "Grip (deg)", color: "#3caea3" },
  { key: "lineL_adc", label: "Line L", color: "#f6d55c" },
  { key: "lineR_adc", label: "Line R", color: "#ed553b" },
  { key: "vbatt_mV", label: "Vbatt (mV)", color: "#173f5f" },
];

export const DEFAULT_SHELF_PALETTE = [
  { id: "-", label: "Empty", color: "#0f172a" },
  { id: "R", label: "Red", color: "#ef4444" },
  { id: "G", label: "Green", color: "#22c55e" },
  { id: "B", label: "Blue", color: "#3b82f6" },
  { id: "Y", label: "Yellow", color: "#facc15" },
  { id: "W", label: "White", color: "#f8fafc" },
  { id: "K", label: "Black", color: "#111827" },
];
