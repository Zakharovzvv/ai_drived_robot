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
  const control = diagnostics.control || {};
  const diagTimestamp = diagnostics.timestamp
    ? new Date(diagnostics.timestamp * 1000).toLocaleTimeString()
    : null;
  const statusFresh =
    meta.status_fresh !== undefined
      ? Boolean(meta.status_fresh)
      : Boolean(serial.connected || wifi.connected === true);

  // Build ESP32 services
  const esp32Services = [];

  // Serial/UART Service
  const serialService = {
    name: "UART (Serial)",
    connected: serial.connected || false,
    details: [],
  };
  if (serial.active_port) {
    serialService.details.push(`Port: ${serial.active_port}`);
  } else if (serial.requested_port) {
    serialService.details.push(`Requested: ${serial.requested_port}`);
  } else {
    serialService.details.push("Auto detect");
  }
  if (serial.error) {
    serialService.details.push(`Error: ${serial.error}`);
  }
  if (typeof serial.status_age_s === "number" && Number.isFinite(serial.status_age_s)) {
    serialService.details.push(`Last update: ${serial.status_age_s.toFixed(1)}s ago`);
  }
  esp32Services.push(serialService);

  // Wi-Fi Service
  const wifiTransport = (control.transports || []).find((t) => t.id === "wifi-ws");
  const wifiService = {
    name: "Wi-Fi",
    connected: wifi.connected === true && statusFresh,
    details: [],
  };
  if (wifi.ip) {
    wifiService.details.push(`IP: ${wifi.ip}`);
  }
  if (wifiTransport && wifiTransport.endpoint) {
    wifiService.details.push(`Endpoint: ${wifiTransport.endpoint}`);
  }
  if (wifiTransport && wifiTransport.available !== undefined) {
    wifiService.details.push(`Transport: ${wifiTransport.available ? "available" : "unavailable"}`);
  }
  if (!statusFresh) {
    wifiService.details.push("No recent telemetry");
  }
  esp32Services.push(wifiService);

  // Camera Service
  const cameraService = {
    name: "Camera",
    connected: camera.configured || false,
    details: [],
  };
  if (camera.resolution) {
    cameraService.details.push(`Resolution: ${camera.resolution}`);
  }
  if (camera.quality !== undefined) {
    cameraService.details.push(`Quality: ${camera.quality}`);
  }
  if (camera.max_resolution) {
    cameraService.details.push(`Max: ${camera.max_resolution}`);
  }
  if (camera.streaming !== undefined) {
    cameraService.details.push(`Streaming: ${camera.streaming ? "ON" : "OFF"}`);
  }
  if (camera.transport) {
    cameraService.details.push(`Transport: ${camera.transport}`);
  }
  if (!camera.configured) {
    cameraService.details.push("Not configured");
  }
  esp32Services.push(cameraService);

  // I2C Service (link to UNO)
  const i2cService = {
    name: "I2C (UNO Link)",
    connected: uno.connected || false,
    details: [],
  };
  if (uno.state_id !== undefined) {
    i2cService.details.push(`UNO State: ${uno.state_id}`);
  }
  if (uno.err_flags !== undefined) {
    i2cService.details.push(`Error flags: ${uno.err_flags}`);
  }
  if (uno.error) {
    i2cService.details.push(`Error: ${uno.error}`);
  }
  if (!statusFresh) {
    i2cService.details.push("No status data");
  }
  esp32Services.push(i2cService);

  // Bluetooth Service (placeholder for future)
  const bluetoothService = {
    name: "Bluetooth",
    connected: false,
    details: ["Not implemented"],
  };
  esp32Services.push(bluetoothService);

  // Determine ESP32 overall status
  const anyServiceConnected = esp32Services.some((s) => s.connected);
  const esp32Status = anyServiceConnected ? "Online" : "Offline";
  const esp32Tone = anyServiceConnected ? "ok" : "error";

  // ESP32 System Info - ESP32 specific data only
  const esp32SystemInfo = [];
  // ESP32 doesn't have its own sensors - all sensor data comes from UNO via I2C

  // Build UNO services
  const unoServices = [];

  // Motors Service
  const motorsConnected = statusFresh && uno.connected && status.drive_left !== undefined;
  const motorsService = {
    name: "Motors (Drive)",
    connected: motorsConnected,
    details: [],
  };
  if (statusFresh && status.drive_left !== undefined) {
    motorsService.details.push(`Left: ${status.drive_left}`);
    motorsService.details.push(`Right: ${status.drive_right || 0}`);
  }
  if (statusFresh && status.mps !== undefined) {
    motorsService.details.push(`Speed: ${status.mps} mps`);
  }
  if (!motorsConnected) {
    motorsService.details.push("No motor data");
  }
  unoServices.push(motorsService);

  // Sensors Service (Line tracking)
  const sensorsConnected = statusFresh && uno.connected && status.line_left !== undefined;
  const sensorsService = {
    name: "Line Sensors",
    connected: sensorsConnected,
    details: [],
  };
  if (statusFresh && status.line_left !== undefined) {
    sensorsService.details.push(`Left: ${status.line_left}`);
    sensorsService.details.push(`Right: ${status.line_right || 0}`);
    if (status.line_thr !== undefined) {
      sensorsService.details.push(`Threshold: ${status.line_thr}`);
    }
  }
  if (!sensorsConnected) {
    sensorsService.details.push("No sensor data");
  }
  unoServices.push(sensorsService);

  // Manipulator Service (Lift & Grip)
  const manipulatorConnected = statusFresh && uno.connected && status.elev_mm !== undefined;
  const manipulatorService = {
    name: "Manipulator",
    connected: manipulatorConnected,
    details: [],
  };
  if (statusFresh && status.elev_mm !== undefined) {
    manipulatorService.details.push(`Lift: ${status.elev_mm} mm`);
    if (status.lift_enc !== undefined) {
      manipulatorService.details.push(`Lift encoder: ${status.lift_enc}`);
    }
  }
  if (statusFresh && status.grip_deg !== undefined) {
    manipulatorService.details.push(`Grip: ${status.grip_deg}°`);
    if (status.grip_enc !== undefined) {
      manipulatorService.details.push(`Grip encoder: ${status.grip_enc}`);
    }
  }
  if (!manipulatorConnected) {
    manipulatorService.details.push("No manipulator data");
  }
  unoServices.push(manipulatorService);

  // Power Service
  const powerConnected = statusFresh && uno.connected && status.vbatt_mV !== undefined;
  const powerService = {
    name: "Power & Battery",
    connected: powerConnected,
    details: [],
  };
  if (statusFresh && status.vbatt_mV !== undefined) {
    const voltage = (status.vbatt_mV / 1000).toFixed(2);
    powerService.details.push(`Voltage: ${voltage} V (${status.vbatt_mV} mV)`);
  }
  if (statusFresh && status.estop !== undefined) {
    powerService.details.push(`E-Stop: ${status.estop ? "ACTIVE" : "Clear"}`);
  }
  if (!powerConnected) {
    powerService.details.push("No power data");
  }
  unoServices.push(powerService);

  // UNO System Info
  const unoSystemInfo = [];
  if (uno.state_id !== undefined) unoSystemInfo.push(`State ID: ${uno.state_id}`);
  if (uno.err_flags !== undefined) unoSystemInfo.push(`Error flags: ${uno.err_flags}`);
  if (uno.seq_ack !== undefined) unoSystemInfo.push(`Seq ACK: ${uno.seq_ack}`);
  if (uno.error) unoSystemInfo.push(`Error: ${uno.error}`);

  cards.push({
    type: "device",
    title: "ESP32",
    value: esp32Status,
    tone: esp32Tone,
    timestamp: diagTimestamp,
    services: esp32Services,
    systemInfo: esp32SystemInfo,
  });

  cards.push({
    type: "device",
    title: "Arduino UNO",
    value: uno.connected ? "Online" : "Offline",
    tone: uno.connected ? "ok" : "error",
    timestamp: diagTimestamp,
    services: unoServices,
    systemInfo: unoSystemInfo.filter(Boolean),
  });

  return cards;
}

function ServiceStatus({ name, connected, details }) {
  return (
    <div className="service-status" data-connected={connected}>
      <div className="service-header">
        <span className="service-indicator" data-state={connected ? "ok" : "error"} />
        <h4>{name}</h4>
        <span className="service-state">{connected ? "Online" : "Offline"}</span>
      </div>
      {details && details.length > 0 && (
        <ul className="service-details">
          {details.map((detail, index) => (
            <li key={index}>{detail}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeviceCard({ title, value, tone, timestamp, services, systemInfo }) {
  const dataState = tone !== "default" ? { "data-state": tone } : {};
  return (
    <article className="device-card" {...dataState}>
      <div className="device-card-header">
        <div>
          <h3>{title}</h3>
          <span className="device-status">{value}</span>
        </div>
        {timestamp && <time className="device-timestamp">{timestamp}</time>}
      </div>

      {services && services.length > 0 && (
        <div className="device-services">
          <h4 className="services-title">Services</h4>
          {services.map((service, index) => (
            <ServiceStatus key={index} {...service} />
          ))}
        </div>
      )}

      {systemInfo && systemInfo.length > 0 && (
        <div className="device-system-info">
          <h4 className="system-info-title">System Info</h4>
          <ul>
            {systemInfo.map((info, index) => (
              <li key={index}>{info}</li>
            ))}
          </ul>
        </div>
      )}
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
      <div className="status-devices-grid" role="region" aria-live="polite">
        {cards.length ? (
          cards.map((card) => <DeviceCard key={card.title} {...card} />)
        ) : (
          <p style={{ gridColumn: "1/-1", color: "var(--color-text-muted)", textAlign: "center" }}>
            No diagnostics data available
          </p>
        )}
      </div>
    </section>
  );
}
