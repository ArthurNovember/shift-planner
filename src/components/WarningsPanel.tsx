import type { ScheduleWarning } from '../types';

interface Props {
  warnings: ScheduleWarning[];
}

const SEVERITY: Record<ScheduleWarning['type'], 'high' | 'medium'> = {
  'pt-hours-exceeded': 'high',
  'coverage-gap': 'high',
  'pt-hours-near-limit': 'medium',
  'weekend-uneven': 'medium',
};

export function WarningsPanel({ warnings }: Props) {
  return (
    <section className="panel">
      <h2>Upozornění</h2>
      {warnings.length === 0 ? (
        <p className="muted">Žádná upozornění – rozvrh vypadá v pořádku.</p>
      ) : (
        <ul className="warnings-list">
          {warnings.map((w, i) => (
            <li key={i} className={`warning warning-${SEVERITY[w.type]}`}>
              {w.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
