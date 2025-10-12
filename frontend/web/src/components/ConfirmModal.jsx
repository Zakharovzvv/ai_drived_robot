import { useCallback } from "react";
import { useOperator } from "../state/OperatorProvider.jsx";

export default function ConfirmModal() {
  const { modalState, resolveModal } = useOperator();

  const handleOverlayClick = useCallback(
    (event) => {
      if (event.target === event.currentTarget) {
        resolveModal(false);
      }
    },
    [resolveModal]
  );

  if (!modalState) {
    return null;
  }

  return (
    <div
      id="modal-overlay"
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      onClick={handleOverlayClick}
    >
      <div className="modal-content">
        <h2 id="modal-title">{modalState.title}</h2>
        <p id="modal-message">{modalState.message}</p>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={() => resolveModal(false)}>
            Cancel
          </button>
          <button className="btn-danger" onClick={() => resolveModal(true)}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
