import { useEffect, useRef, useState } from 'react';
import type { ScheduleWarning } from '../types';

interface Props {
  warnings: ScheduleWarning[];
  onWarningClick?: (date: string) => void;
  onDismiss: (message: string) => void;
  dismissedWarnings: ScheduleWarning[];
  onRestore: (message: string) => void;
  /** Identifies which month `warnings` belongs to, so switching months (which can surface a
   * different set of pre-existing warnings) isn't mistaken for something newly gone wrong. */
  monthKey: string;
}

const SEVERITY: Record<ScheduleWarning['type'], 'high' | 'medium'> = {
  'pt-hours-exceeded': 'high',
  'ft-hours-deviation': 'high',
  'coverage-gap': 'high',
  'availability-conflict': 'high',
  'holiday-shift': 'medium',
};

const AUTO_PEEK_MS = 3000;

export function WarningsPanel({
  warnings,
  onWarningClick,
  onDismiss,
  dismissedWarnings,
  onRestore,
  monthKey,
}: Props) {
  const [open, setOpen] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevKeyRef = useRef<string | null>(null);
  const prevMessagesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  function clearAutoCloseTimer() {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }

  // Auto-peek: briefly pop the dropdown open on its own when a genuinely new warning shows up
  // (something an edit just broke), rather than making someone notice the badge and click in.
  // Never fires for the initial load or a month switch - both can surface pre-existing warnings
  // that aren't "new" in the sense that matters here - and never interrupts someone who already
  // has it open reading.
  useEffect(() => {
    const currentMessages = new Set(warnings.map((w) => w.message));
    const sameMonth = prevKeyRef.current === monthKey;
    const prevMessages = prevMessagesRef.current;
    prevKeyRef.current = monthKey;
    prevMessagesRef.current = currentMessages;
    if (!sameMonth || openRef.current) return;
    const hasNew = [...currentMessages].some((m) => !prevMessages.has(m));
    if (!hasNew) return;
    setOpen(true);
    clearAutoCloseTimer();
    const timer = setTimeout(() => setOpen(false), AUTO_PEEK_MS);
    timeoutRef.current = timer;
    return () => clearTimeout(timer);
  }, [warnings, monthKey]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        clearAutoCloseTimer();
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  function handleToggle() {
    clearAutoCloseTimer();
    setOpen((v) => !v);
  }

  // Jumping to a warning's day is pointless if this dropdown just stays open sitting on top of
  // it - close it first so the schedule (and the day highlight/scroll below) is actually visible.
  function handleWarningMessageClick(date: string) {
    clearAutoCloseTimer();
    setOpen(false);
    onWarningClick?.(date);
  }

  return (
    <div className="warnings-widget" ref={containerRef}>
      <button
        type="button"
        className="icon-btn warnings-toggle"
        onClick={handleToggle}
        aria-expanded={open}
        aria-label={`Upozornění${warnings.length > 0 ? ` (${warnings.length})` : ''}`}
        title="Upozornění"
      >
        ⚠
        {warnings.length > 0 && <span className="warnings-badge">{warnings.length}</span>}
      </button>
      {open && (
        <div className="warnings-dropdown panel">
          <h2>Upozornění</h2>
          {warnings.length === 0 ? (
            <p className="muted">Žádná upozornění – rozvrh vypadá v pořádku.</p>
          ) : (
            <ul className="warnings-list">
              {warnings.map((w, i) => (
                <li key={i} className={`warning warning-${SEVERITY[w.type]} warning-row`}>
                  {w.date ? (
                    <button
                      type="button"
                      className="warning-message warning-clickable"
                      onClick={() => handleWarningMessageClick(w.date!)}
                    >
                      {w.message}
                    </button>
                  ) : (
                    <span className="warning-message">{w.message}</span>
                  )}
                  <button
                    type="button"
                    className="warning-dismiss"
                    title="Vím o tom, je to v pořádku - skrýt toto upozornění"
                    onClick={() => onDismiss(w.message)}
                  >
                    ✓
                  </button>
                </li>
              ))}
            </ul>
          )}

          {dismissedWarnings.length > 0 && (
            <div className="dismissed-warnings">
              <button type="button" className="dismissed-toggle" onClick={() => setShowDismissed((v) => !v)}>
                {showDismissed ? 'Skrýt' : 'Zobrazit'} skrytá upozornění ({dismissedWarnings.length})
              </button>
              {showDismissed && (
                <ul className="warnings-list">
                  {dismissedWarnings.map((w, i) => (
                    <li key={i} className="warning warning-dismissed-item warning-row">
                      <span className="warning-message">{w.message}</span>
                      <button
                        type="button"
                        className="warning-dismiss"
                        title="Zobrazit toto upozornění zpátky"
                        onClick={() => onRestore(w.message)}
                      >
                        ↺
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
