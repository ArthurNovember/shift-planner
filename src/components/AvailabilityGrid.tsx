import type { AvailabilityKind, Employee, UnavailabilityMap } from '../types';
import { daysInMonth, toISODate } from '../scheduler';

interface Props {
  year: number;
  month: number;
  employees: Employee[];
  unavailability: UnavailabilityMap;
  onToggle: (employeeId: string, iso: string, kind?: AvailabilityKind) => void;
}

export function AvailabilityGrid({ year, month, employees, unavailability, onToggle }: Props) {
  const totalDays = daysInMonth(year, month);
  const days = Array.from({ length: totalDays }, (_, i) => new Date(year, month, i + 1));

  return (
    <section className="panel availability-panel">
      <h2>Nedostupnost</h2>
      <p className="muted">
        Označte, kdy daný člověk nemůže pracovat - u všedních dnů zvlášť pro ranní (R) a odpolední (O) směnu,
        generátor je bude respektovat.
      </p>
      <div className="availability-scroll">
        <table className="availability-table">
          <thead>
            <tr>
              <th></th>
              {days.map((d) => {
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                return (
                  <th key={d.getDate()} className={isWeekend ? 'weekend' : undefined}>
                    {d.getDate()}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {employees.map((emp) => (
              <tr key={emp.id}>
                <td className="availability-name">{emp.name}</td>
                {days.map((d) => {
                  const iso = toISODate(d);
                  const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                  const marks = unavailability[emp.id]?.[iso];
                  const morningOff = marks?.has('morning') ?? false;
                  const afternoonOff = marks?.has('afternoon') ?? false;

                  if (isWeekend) {
                    const dayOff = morningOff && afternoonOff;
                    return (
                      <td key={iso} className="weekend">
                        <button
                          type="button"
                          className={`availability-cell${dayOff ? ' unavailable' : ''}`}
                          title={`${emp.name}: ${iso}${dayOff ? ' (nedostupný)' : ''}`}
                          onClick={() => onToggle(emp.id, iso)}
                        >
                          {dayOff ? '×' : ''}
                        </button>
                      </td>
                    );
                  }

                  return (
                    <td key={iso}>
                      <div className="availability-cell-split">
                        <button
                          type="button"
                          className={`availability-subcell${morningOff ? ' unavailable' : ''}`}
                          title={`${emp.name}: ${iso} ranní${morningOff ? ' (nedostupný)' : ''}`}
                          onClick={() => onToggle(emp.id, iso, 'morning')}
                        >
                          R
                        </button>
                        <button
                          type="button"
                          className={`availability-subcell${afternoonOff ? ' unavailable' : ''}`}
                          title={`${emp.name}: ${iso} odpolední${afternoonOff ? ' (nedostupný)' : ''}`}
                          onClick={() => onToggle(emp.id, iso, 'afternoon')}
                        >
                          O
                        </button>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
