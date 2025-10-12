import { useOperator } from "../state/OperatorProvider.jsx";

const icons = {
  success: (
    <svg className="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ),
  error: (
    <svg className="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
  warning: (
    <svg className="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
  info: (
    <svg className="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
};

export default function ToastHost() {
  const { toasts, removeToast } = useOperator();

  if (!toasts.length) {
    return null;
  }

  return (
    <div id="toast-container" aria-live="assertive" aria-atomic="true">
      {toasts.map((toast) => {
        const tone = toast.tone || "info";
        return (
          <div key={toast.id} className={`toast ${tone}`} onClick={() => removeToast(toast.id)}>
            {icons[tone] || icons.info}
            <div className="toast-message">{toast.message}</div>
          </div>
        );
      })}
    </div>
  );
}
