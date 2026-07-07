import { useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from '../storage';

interface Props {
  /** This month's entries, oldest first. */
  entries: HistoryEntry[];
  /** Whether this browser hasn't seen the newest entry yet. */
  hasUnseen: boolean;
  /** Called when the dropdown is opened, so the caller can mark the newest entry as seen. */
  onOpen: () => void;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('cs-CZ', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function HistoryPanel({ entries, hasUnseen, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  function handleToggle() {
    const next = !open;
    setOpen(next);
    if (next) onOpen();
  }

  const newestFirst = [...entries].reverse();

  return (
    <div className="history-widget" ref={containerRef}>
      <button
        type="button"
        className="secondary-btn history-toggle"
        onClick={handleToggle}
        aria-expanded={open}
      >
        Historie úprav
        {hasUnseen && (
          <span className="history-badge" aria-label="Nové úpravy od poslední návštěvy">
            !
          </span>
        )}
      </button>
      {open && (
        <div className="history-dropdown panel">
          <h2>Historie úprav – tento měsíc</h2>
          {newestFirst.length === 0 ? (
            <p className="muted">Pro tento měsíc zatím nejsou žádné zaznamenané úpravy.</p>
          ) : (
            <ul className="history-list">
              {newestFirst.map((entry, i) => (
                <li key={i} className="history-entry">
                  <span className="history-timestamp">{formatTimestamp(entry.timestamp)}</span>
                  <span className="history-message">{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
