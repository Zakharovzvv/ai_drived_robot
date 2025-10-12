import { useEffect, useMemo } from "react";
import { useOperator } from "../state/OperatorProvider.jsx";

function formatTimestamp(value) {
  if (!value && value !== 0) return "";
  const millis = value > 1e12 ? value : value * 1000;
  try {
    return new Date(millis).toLocaleString();
  } catch (error) {
    return String(value);
  }
}

export default function LogsPage() {
  const {
    logEntries,
    logFilters,
    setLogFilters,
    logSort,
    setLogSort,
    connectLogSocket,
    disconnectLogSocket,
    fetchLogsSnapshot,
  } = useOperator();

  useEffect(() => {
    connectLogSocket();
    fetchLogsSnapshot({ limit: 200 }).catch(() => {});
    return () => {
      disconnectLogSocket();
    };
  }, [connectLogSocket, disconnectLogSocket, fetchLogsSnapshot]);

  const options = useMemo(() => {
    const sources = new Set(["all"]);
    const devices = new Set(["all"]);
    const parameters = new Set(["all"]);
    logEntries.forEach((entry) => {
      if (entry?.source) sources.add(entry.source);
      if (entry?.device) devices.add(entry.device);
      if (entry?.parameter) parameters.add(entry.parameter);
    });
    return {
      sources: Array.from(sources),
      devices: Array.from(devices),
      parameters: Array.from(parameters),
    };
  }, [logEntries]);

  const updateSort = (column) => {
    if (!column) return;
    setLogSort((prev) => {
      if (prev.column === column) {
        const nextDirection = prev.direction === "asc" ? "desc" : "asc";
        return { column, direction: nextDirection };
      }
      return { column, direction: column === "timestamp" ? "desc" : "asc" };
    });
  };

  return (
    <section className="tab-content active" data-tab-content="logs">
      <div className="section-header">
        <h2>Robot Logs</h2>
        <button
          id="refresh-logs"
          type="button"
          className="btn-icon"
          aria-label="Refresh logs"
          title="Refresh logs"
          onClick={() => fetchLogsSnapshot({ limit: 200 }).catch(() => {})}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
          </svg>
        </button>
      </div>
      <div className="log-controls">
        <div className="log-search">
          <label htmlFor="log-search-input" className="sr-only">
            Search logs
          </label>
          <input
            id="log-search-input"
            type="search"
            value={logFilters.search}
            onChange={(event) => setLogFilters((prev) => ({ ...prev, search: event.target.value }))}
            placeholder="Search logs"
            aria-label="Search logs"
          />
        </div>
        <div className="log-filters">
          <label>
            Source
            <select
              value={logFilters.source}
              onChange={(event) => setLogFilters((prev) => ({ ...prev, source: event.target.value }))}
              aria-label="Filter by source"
            >
              {options.sources.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All" : value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Device
            <select
              value={logFilters.device}
              onChange={(event) => setLogFilters((prev) => ({ ...prev, device: event.target.value }))}
              aria-label="Filter by device"
            >
              {options.devices.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All" : value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Parameter
            <select
              value={logFilters.parameter}
              onChange={(event) => setLogFilters((prev) => ({ ...prev, parameter: event.target.value }))}
              aria-label="Filter by parameter"
            >
              {options.parameters.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All" : value}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="log-table-container">
        <table className="log-table" aria-label="Robot logs">
          <thead>
            <tr>
              {[
                { key: "timestamp", label: "Date / Time" },
                { key: "source", label: "Source" },
                { key: "device", label: "Device" },
                { key: "parameter", label: "Parameter" },
                { key: "value", label: "Value" },
              ].map((column) => {
                const isActive = logSort.column === column.key;
                const ariaSort = isActive ? (logSort.direction === "asc" ? "ascending" : "descending") : "none";
                return (
                  <th
                    key={column.key}
                    scope="col"
                    data-sort={column.key}
                    tabIndex={0}
                    role="button"
                    aria-sort={ariaSort}
                    onClick={() => updateSort(column.key)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        updateSort(column.key);
                      }
                    }}
                  >
                    {column.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {logEntries.length ? (
              logEntries.map((entry) => (
                <tr key={entry.id || `${entry.timestamp}-${entry.parameter || "log"}`}>
                  <td>{formatTimestamp(entry.timestamp)}</td>
                  <td>{entry.source || "—"}</td>
                  <td>{entry.device || "—"}</td>
                  <td>{entry.parameter || "—"}</td>
                  <td>{entry.value != null ? entry.value : entry.raw || "—"}</td>
                </tr>
              ))
            ) : (
              <tr className="log-empty">
                <td colSpan={5}>No logs yet…</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
