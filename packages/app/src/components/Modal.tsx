import React from 'react';

interface ModalProps {
  isOpen: boolean;
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  id?: string;
  width?: string;
  'aria-label'?: string;
}

export function Modal({
  isOpen,
  title,
  onClose,
  children,
  id,
  width,
  'aria-label': ariaLabel,
}: ModalProps) {
  if (!isOpen) return null;
  return (
    <div
      id={id}
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-header-row">
          <div className="modal-heading">{title}</div>
          <button className="btn-modal-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
