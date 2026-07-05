import type { Employee } from '../types';
import { FULLTIME_HOURS_TOLERANCE, FULLTIME_TARGET_HOURS, PARTTIME_MONTHLY_CAP } from '../types';

interface Props {
  employees: Employee[];
  hoursByEmployee: Map<string, number>;
}

export function HoursSummary({ employees, hoursByEmployee }: Props) {
  return (
    <section className="panel">
      <h2>Hodiny za měsíc</h2>
      <table className="hours-table">
        <thead>
          <tr>
            <th>Zaměstnanec</th>
            <th>Hodiny</th>
            <th>Limit</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((emp) => {
            const hours = hoursByEmployee.get(emp.id) ?? 0;
            const over =
              emp.type === 'parttime' ? hours > PARTTIME_MONTHLY_CAP : hours - FULLTIME_TARGET_HOURS > FULLTIME_HOURS_TOLERANCE;
            return (
              <tr key={emp.id}>
                <td>{emp.name}</td>
                <td className={over ? 'over-limit' : undefined}>{hours.toFixed(1)} h</td>
                <td>{emp.type === 'parttime' ? `${PARTTIME_MONTHLY_CAP} h` : `${FULLTIME_TARGET_HOURS} h`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
