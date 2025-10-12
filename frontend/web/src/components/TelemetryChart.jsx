import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";
import { METRIC_CONFIG } from "../constants.js";

export default function TelemetryChart({ samples }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }

    const chart = new Chart(context, {
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
    chartRef.current = chart;

    return () => {
      chart.destroy();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }
    const labels = samples.map((sample) => new Date(sample.timestamp).toLocaleTimeString());
    chart.data.labels = labels;
    chart.data.datasets = METRIC_CONFIG.map((metric) => ({
      label: metric.label,
      data: samples.map((sample) => sample.data[metric.key] ?? null),
      borderColor: metric.color,
      backgroundColor: `${metric.color}20`,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
    }));
    chart.update("none");
  }, [samples]);

  return <canvas ref={canvasRef} role="img" aria-label="Real-time telemetry chart" />;
}
