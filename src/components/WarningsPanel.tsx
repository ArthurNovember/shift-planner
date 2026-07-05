import type { ScheduleWarning } from '../types';

interface Props {
  warnings: ScheduleWarning[];
  onWarningClick?: (date: string) => void;
  minHeight?: number;
}

const SEVERITY: Record<ScheduleWarning['type'], 'high' | 'medium'> = {
  'pt-hours-exceeded': 'high',
  'ft-hours-deviation': 'high',
  'coverage-gap': 'high',
  'availability-conflict': 'high',
  'weekend-uneven': 'medium',
};

export function WarningsPanel({ warnings, onWarningClick, minHeight }: Props) {
  return (
    <section className="panel" style={minHeight ? { minHeight } : undefined}>
      <h2>Upozornění</h2>
      {warnings.length === 0 ? (
        <p className="muted">Žádná upozornění – rozvrh vypadá v pořádku.</p>
      ) : (
        <ul className="warnings-list">
          {warnings.map((w, i) =>
            w.date ? (
              <li key={i}>
                <button
                  type="button"
                  className={`warning warning-${SEVERITY[w.type]} warning-clickable`}
                  onClick={() => onWarningClick?.(w.date!)}
                >
                  {w.message}
                </button>
              </li>
            ) : (
              <li key={i} className={`warning warning-${SEVERITY[w.type]}`}>
                {w.message}
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
