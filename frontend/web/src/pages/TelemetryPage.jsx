import TelemetryChart from "../components/TelemetryChart.jsx";
import { METRIC_CONFIG } from "../constants.js";
import { useOperator } from "../state/OperatorProvider.jsx";

export default function TelemetryPage() {
  const { telemetrySamples } = useOperator();

  return (
    <section className="tab-content active" data-tab-content="telemetry">
      <div className="section-header">
        <h2>Live Telemetry</h2>
        <div className="legend" role="list">
          {METRIC_CONFIG.map((metric) => (
            <span
              key={metric.key}
              className="legend-item"
              role="listitem"
              style={{ "--color": metric.color }}
            >
              <i />
              <span>{metric.label}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="chart-container">
        <TelemetryChart samples={telemetrySamples} />
      </div>
    </section>
  );
}
