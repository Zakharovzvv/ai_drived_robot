import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useOperator } from "../state/OperatorProvider.jsx";

export default function CommandBar() {
  const navigate = useNavigate();
  const { startTask, executeRawCommand, brake, confirm } = useOperator();
  const [taskId, setTaskId] = useState("default");
  const [command, setCommand] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isBraking, setIsBraking] = useState(false);
  
  // Load expanded state from localStorage, default to true on desktop, false on mobile
  const [isExpanded, setIsExpanded] = useState(() => {
    const saved = localStorage.getItem("commandBarExpanded");
    if (saved !== null) {
      return saved === "true";
    }
    // Default to collapsed on mobile screens
    return window.innerWidth > 768;
  });

  // Save expanded state to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem("commandBarExpanded", String(isExpanded));
  }, [isExpanded]);

  const handleStart = useCallback(
    async (event) => {
      event.preventDefault();
      if (isStarting) return;
      setIsStarting(true);
      try {
        await startTask(taskId.trim());
      } finally {
        setIsStarting(false);
      }
    },
    [isStarting, startTask, taskId]
  );

  const handleCommand = useCallback(
    async (event) => {
      event.preventDefault();
      if (isExecuting) return;
      const trimmed = command.trim();
      if (!trimmed) {
        return;
      }
      setIsExecuting(true);
      try {
        await executeRawCommand(trimmed);
      } finally {
        setIsExecuting(false);
        navigate("/output");
      }
    },
    [command, executeRawCommand, isExecuting, navigate]
  );

  const handleBrake = useCallback(async () => {
    if (isBraking) return;
    const confirmed = await confirm(
      "Emergency Stop",
      "This will immediately stop all actuators. Are you sure?"
    );
    if (!confirmed) return;
    setIsBraking(true);
    try {
      await brake();
    } finally {
      setIsBraking(false);
    }
  }, [brake, confirm, isBraking]);

  useEffect(() => {
    const handler = (event) => {
      // Ctrl/Cmd+B for BRAKE
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        handleBrake();
      }
      // Ctrl/Cmd+Shift+C to toggle command bar
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        setIsExpanded((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleBrake]);

  return (
    <div className={`command-bar ${isExpanded ? 'expanded' : 'collapsed'}`}>
      <div className="command-bar-toggle">
        <button
          type="button"
          className="btn-toggle"
          onClick={() => setIsExpanded(!isExpanded)}
          title={isExpanded ? "Collapse command bar (Ctrl+Shift+C)" : "Expand command bar (Ctrl+Shift+C)"}
          aria-label={isExpanded ? "Collapse command bar" : "Expand command bar"}
          aria-expanded={isExpanded}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {isExpanded ? (
              <polyline points="18 15 12 9 6 15" />
            ) : (
              <polyline points="6 9 12 15 18 9" />
            )}
          </svg>
          <span className="toggle-text">{isExpanded ? 'Hide' : 'Show'} Commands</span>
        </button>
      </div>

            <div className="command-bar-content" style={{ display: isExpanded ? 'flex' : 'none' }}>
        <div className="command-group command-group-task">
          <label className="command-group-label">Task Execution</label>
          <form className="inline-form" onSubmit={handleStart}>
            <input
              name="task"
              type="text"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
              placeholder="default, pick, place..."
              aria-label="Task identifier"
              title="Enter task ID to execute a predefined robot scenario"
            />
            <button type="submit" className="btn-primary btn-action" disabled={isStarting} title="Start autonomous task">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              {isStarting ? "Starting…" : "Start Task"}
            </button>
          </form>
        </div>

        <div className="command-group command-group-emergency">
          <label className="command-group-label">Emergency</label>
          <button
            type="button"
            className="btn-danger btn-action"
            onClick={handleBrake}
            disabled={isBraking}
            aria-keyshortcuts="Control+B"
            title="Emergency stop all actuators (Ctrl+B)"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <rect x="9" y="9" width="6" height="6" />
            </svg>
            {isBraking ? "Stopping…" : "BRAKE"}
          </button>
        </div>

        <div className="command-group command-group-debug">
          <label className="command-group-label">Direct Command</label>
          <form className="inline-form command-input-group" onSubmit={handleCommand}>
            <input
              name="command"
              type="text"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="STATUS, CTRL ..., CAMCFG ..., SMAP ..."
              aria-label="Direct CLI command"
              title="Send low-level CLI command for debugging and manual control"
            />
            <button type="submit" className="btn-secondary btn-action" disabled={isExecuting} title="Send CLI command">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              {isExecuting ? "Sending…" : "Send"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
