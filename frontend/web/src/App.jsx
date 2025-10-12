import { Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "./layout/AppLayout.jsx";
import TelemetryPage from "./pages/TelemetryPage.jsx";
import CameraPage from "./pages/CameraPage.jsx";
import StatusPage from "./pages/StatusPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import LogsPage from "./pages/LogsPage.jsx";
import OutputPage from "./pages/OutputPage.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<Navigate to="telemetry" replace />} />
        <Route path="telemetry" element={<TelemetryPage />} />
        <Route path="camera" element={<CameraPage />} />
        <Route path="status" element={<StatusPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="output" element={<OutputPage />} />
        <Route path="*" element={<Navigate to="telemetry" replace />} />
      </Route>
    </Routes>
  );
}
