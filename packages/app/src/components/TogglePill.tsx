import React from 'react';

interface TogglePillOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  id?: string;
}

type TogglePillVariant = 'mode' | 'find-tab' | 'player-mode';

interface VariantConfig {
  containerClass: string;
  trackClass: string;
  optionClass: string;
  dataAttr: string;
  /** 'button' renders a single clickable container that cycles values;
   *  'div' renders individual buttons per option */
  as: 'button' | 'div';
}

const VARIANTS: Record<TogglePillVariant, VariantConfig> = {
  'mode':        { containerClass: 'mode-toggle',        trackClass: 'mode-track',      optionClass: 'mode-option',   dataAttr: 'data-mode', as: 'button' },
  'find-tab':    { containerClass: 'find-tab-toggle',    trackClass: 'find-tab-track',  optionClass: 'find-tab-btn',  dataAttr: 'data-tab',  as: 'div'    },
  'player-mode': { containerClass: 'player-mode-toggle', trackClass: 'pmt-track',       optionClass: 'pmt-opt',       dataAttr: 'data-mode', as: 'div'    },
};

interface TogglePillProps<T extends string = string> {
  variant: TogglePillVariant;
  value: T;
  onChange: (value: T) => void;
  options: TogglePillOption<T>[];
  id?: string;
  title?: string;
}

export function TogglePill<T extends string = string>({ variant, value, onChange, options, id, title }: TogglePillProps<T>) {
  const { containerClass, trackClass, optionClass, dataAttr, as: Tag } = VARIANTS[variant];
  const dataProps = { [dataAttr]: value };

  if (Tag === 'button') {
    const handleClick = () => {
      const idx = options.findIndex(o => o.value === value);
      onChange(options[(idx + 1) % options.length]!.value);
    };
    return (
      <button id={id} className={containerClass} {...dataProps} title={title} onClick={handleClick}>
        <span className={trackClass}></span>
        {options.map(opt => (
          <span key={opt.value} className={optionClass}>{opt.label}</span>
        ))}
      </button>
    );
  }

  return (
    <div id={id} className={containerClass} {...dataProps}>
      <span className={trackClass}></span>
      {options.map(opt => (
        <button key={opt.value} className={optionClass} id={opt.id} onClick={() => onChange(opt.value)}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}
