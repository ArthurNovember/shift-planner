import type { Employee, UnavailabilityMap } from '../types';
import { daysInMonth, toISODate } from '../scheduler';

interface Props {
  year: number;
  month: number;
  employees: Employee[];
  unavailability: UnavailabilityMap;
  onToggle: (employeeId: string, iso: string) => void;
}

export function AvailabilityGrid({ year, month, employees, unavailability, onToggle }: Props) {
  const totalDays = daysInMonth(year, month);
  const days = Array.from({ length: totalDays }, (_, i) => new Date(year, month, i + 1));

  return (
    <section className="panel availability-panel">
      <h2>Nedostupnost</h2>
      <p className="muted">Označte dny, kdy daný člověk nemůže pracovat - generátor je bude respektovat.</p>
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
                  const isUnavailable = unavailability[emp.id]?.has(iso) ?? false;
                  return (
                    <td key={iso} className={isWeekend ? 'weekend' : undefined}>
                      <button
                        type="button"
                        className={`availability-cell${isUnavailable ? ' unavailable' : ''}`}
                        title={`${emp.name}: ${iso}${isUnavailable ? ' (nedostupný)' : ''}`}
                        onClick={() => onToggle(emp.id, iso)}
                      >
                        {isUnavailable ? '×' : ''}
                      </button>
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
