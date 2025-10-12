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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        handleBrake();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleBrake]);

  return (
    <div className="command-bar">
      <div className="command-bar-content">
        <form className="inline-form" onSubmit={handleStart}>
          <input
            name="task"
            type="text"
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            placeholder="Task ID"
            aria-label="Task identifier"
          />
          <button type="submit" className="btn-primary btn-action" disabled={isStarting} title="Start task">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            {isStarting ? "Starting…" : "Start Task"}
          </button>
        </form>

        <button
          type="button"
          className="btn-danger btn-action"
          onClick={handleBrake}
          disabled={isBraking}
          aria-keyshortcuts="Control+B"
          title="Emergency stop (Ctrl+B)"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <rect x="9" y="9" width="6" height="6" />
          </svg>
          {isBraking ? "Stopping…" : "BRAKE"}
        </button>

        <form className="inline-form command-input-group" onSubmit={handleCommand}>
          <input
            name="command"
            type="text"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Enter CLI command (e.g., STATUS)"
            aria-label="Direct CLI command"
          />
          <button type="submit" className="btn-secondary btn-action" disabled={isExecuting} title="Send command">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
            {isExecuting ? "Sending…" : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}
