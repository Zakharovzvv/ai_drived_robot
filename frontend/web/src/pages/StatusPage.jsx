import { useMemo } from "react";
import { useOperator } from "../state/OperatorProvider.jsx";

function buildCards(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object" || !Object.keys(diagnostics).length) {
    return [];
  }

  const cards = [];
  const serial = diagnostics.serial || {};
  const uno = diagnostics.uno || {};
  const wifi = diagnostics.wifi || {};
  const camera = diagnostics.camera || {};
  const status = diagnostics.status || {};
  const meta = diagnostics.meta || {};
  const diagTimestamp = diagnostics.timestamp
    ? new Date(diagnostics.timestamp * 1000).toLocaleTimeString()
    : null;
  const statusFresh =
    meta.status_fresh !== undefined
      ? Boolean(meta.status_fresh)
      : Boolean(serial.connected || wifi.connected === true);
  const wifiConnected = statusFresh && wifi.connected === true;
  const serialConnected = statusFresh && serial.connected === true;

  const serialStatusErrorDetail =
    serial.status_error === "no_data"
      ? "Status error: no data from ESP32"
      : serial.status_error
      ? `Status error: ${serial.status_error}`
      : null;

  cards.push({
    title: "ESP32 Serial",
    value: serial.connected ? "Connected" : "Disconnected",
    tone: serial.connected ? "ok" : "error",
    details: [
      diagTimestamp && `Updated: ${diagTimestamp}`,
      serial.active_port
        ? `Port: ${serial.active_port}`
        : serial.requested_port
        ? `Requested: ${serial.requested_port}`
        : "Auto detect",
      serial.error && `Error: ${serial.error}`,
      serialStatusErrorDetail,
      typeof serial.status_age_s === "number" && Number.isFinite(serial.status_age_s)
        ? `Last update: ${serial.status_age_s.toFixed(1)} s ago`
        : null,
      serial.stale ? "Status stale" : null,
    ].filter(Boolean),
  });

  cards.push({
    title: "UNO / I2C",
    value: uno.connected ? "Online" : "Offline",
    tone: uno.connected ? "ok" : "error",
    details: [
      uno.error && `status_error=${uno.error}`,
      uno.state_id !== undefined && `state_id=${uno.state_id}`,
      uno.err_flags !== undefined && `err_flags=${uno.err_flags}`,
      uno.seq_ack !== undefined && `seq_ack=${uno.seq_ack}`,
    ].filter(Boolean),
  });

  const wifiHasState = wifi.connected === true || wifi.connected === false;
  let wifiValue = "Unknown";
  let wifiTone = "default";
  if (!statusFresh) {
    wifiValue = "Unavailable";
    wifiTone = "warn";
  } else if (wifiHasState) {
    wifiValue = wifi.connected ? "Connected" : "Disconnected";
    wifiTone = wifi.connected ? "ok" : "warn";
  }
  const wifiDetails = [wifi.ip && `IP: ${wifi.ip}`];
  if (!statusFresh) {
    wifiDetails.unshift("No recent Wi-Fi telemetry");
  }

  cards.push({
    title: "Wi-Fi",
    value: wifiValue,
    tone: wifiTone,
    details: wifiDetails.filter(Boolean),
  });

  cards.push({
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
    ].filter(Boolean),
  });

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

  cards.push({
    title: "STATUS Snapshot",
    value: statusCardValue,
    tone: statusCardTone,
    details: statusDetails,
  });

  const robotConnected = wifiConnected || serialConnected;
  if (!robotConnected) {
    cards.push({
      title: "Robot Link",
      value: "Offline",
      tone: "warn",
      details: ["No active Wi-Fi or serial connection"],
    });
  }

  return cards;
}

function StatusCard({ title, value, tone = "default", details }) {
  const dataState = tone !== "default" ? { "data-state": tone } : {};
  return (
    <article className="status-card" {...dataState}>
      <h3>{title}</h3>
      <span>{value}</span>
      {details && details.length ? (
        <ul className="status-card-details">
          {details.map((detail, index) => (
            <li key={index}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export default function StatusPage() {
  const { diagnostics, fetchDiagnostics } = useOperator();

  const cards = useMemo(() => buildCards(diagnostics), [diagnostics]);

  return (
    <section className="tab-content active" data-tab-content="status">
      <div className="section-header">
        <h2>Robot Status</h2>
        <button
          type="button"
          className="btn-icon"
          aria-label="Refresh status"
          title="Refresh status"
          onClick={fetchDiagnostics}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
          </svg>
        </button>
      </div>
      <div className="status-grid-large" role="region" aria-live="polite">
        {cards.length ? (
          cards.map((card) => (
            <StatusCard key={card.title} {...card} />
          ))
        ) : (
          <p style={{ gridColumn: "1/-1", color: "var(--color-text-muted)", textAlign: "center" }}>
            No diagnostics data available
          </p>
        )}
      </div>
    </section>
  );
}
