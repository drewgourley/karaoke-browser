import React from 'react';

interface QueueListItemProps {
  index: number;
  videoId: string;
  title: string;
  thumbnail?: string;
  singer?: string;
  isCurrent?: boolean;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  /** Rendered inside .qi-actions — omit to hide the actions column entirely */
  actions?: React.ReactNode;
}

export function QueueListItem({
  index, videoId, title, thumbnail, singer, isCurrent,
  draggable: isDraggable, onDragStart, onDragOver, onDrop, actions,
}: QueueListItemProps) {
  const src = thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  return (
    <li
      className={`qi${isCurrent ? ' qi-current' : ''}`}
      draggable={isDraggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span className="qi-num">{index + 1}</span>
      <img className="qi-thumb" src={src} alt="" loading="lazy" />
      <div className="qi-info">
        <span className="qi-title" title={title}>{title}</span>
        {singer && <span className="qi-singer">🎤 {singer}</span>}
      </div>
      {actions && <div className="qi-actions">{actions}</div>}
    </li>
  );
}
