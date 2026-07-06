import { useState } from 'react';
import type { ScheduleWarning } from '../types';

interface Props {
  warnings: ScheduleWarning[];
  onWarningClick?: (date: string) => void;
  minHeight?: number;
  onDismiss: (message: string) => void;
  dismissedWarnings: ScheduleWarning[];
  onRestore: (message: string) => void;
}

const SEVERITY: Record<ScheduleWarning['type'], 'high' | 'medium'> = {
  'pt-hours-exceeded': 'high',
  'ft-hours-deviation': 'high',
  'coverage-gap': 'high',
  'availability-conflict': 'high',
  'holiday-shift': 'medium',
};

export function WarningsPanel({
  warnings,
  onWarningClick,
  minHeight,
  onDismiss,
  dismissedWarnings,
  onRestore,
}: Props) {
  const [showDismissed, setShowDismissed] = useState(false);

  return (
    <section className="panel" style={minHeight ? { minHeight } : undefined}>
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
                  onClick={() => onWarningClick?.(w.date!)}
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
    </section>
  );
}
