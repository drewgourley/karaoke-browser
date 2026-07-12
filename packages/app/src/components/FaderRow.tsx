import React from 'react';

interface FaderRowProps {
  label: React.ReactNode;
  value: number;
  color: string;
  sliderId?: string;
  valueId?: string;
  disabled?: boolean;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
  onChange: (value: number) => void;
  /** Text or JSX rendered in the hint area below the slider */
  hint?: React.ReactNode;
  /** Extra content inserted between the slider and the hint (e.g. VU meter) */
  children?: React.ReactNode;
}

export function FaderRow({
  label, value, color, sliderId, valueId, disabled,
  onPointerDown, onPointerUp, onChange, hint, children,
}: FaderRowProps) {
  return (
    <div className="fader-row">
      <div className="fader-label-row">
        <span>{label}</span>
        <span className="fader-val" id={valueId}>{value}</span>
      </div>
      <input
        type="range"
        id={sliderId}
        className="fader"
        min="0"
        max="100"
        value={value}
        disabled={disabled}
        style={{ '--fader-fill': color, '--pct': value } as React.CSSProperties}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onChange={e => {
          e.currentTarget.style.setProperty('--pct', e.target.value);
          onChange(Number(e.target.value));
        }}
      />
      {children}
      {hint !== undefined && <div className="fader-hint">{hint}</div>}
    </div>
  );
}
