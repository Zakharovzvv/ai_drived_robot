import { useOperator } from "../state/OperatorProvider.jsx";

export default function OutputPage() {
  const { commandOutput, clearCommandOutput } = useOperator();

  return (
    <section className="tab-content active" data-tab-content="output">
      <div className="section-header">
        <h2>Command Output</h2>
        <button
          type="button"
          className="btn-icon"
          aria-label="Clear output"
          title="Clear output"
          onClick={clearCommandOutput}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="output-container">
        <pre className="output" role="log" aria-live="polite" aria-atomic="true">
          {commandOutput || ""}
        </pre>
      </div>
    </section>
  );
}
