import { useCopyToClipboard } from '../hooks/useCopyToClipboard.ts';

interface CopyButtonProps {
  text: string;
  id?: string;
  className?: string;
  resetMs?: number;
}

export function CopyButton({ text, id, className = 'btn-copy-link', resetMs }: CopyButtonProps) {
  const { label, copy } = useCopyToClipboard(resetMs);
  return (
    <button id={id} className={className} onClick={() => void copy(text)}>
      {label}
    </button>
  );
}
