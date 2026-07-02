import type { Employee, EmployeeType } from '../types';
import { employeeColor } from '../colors';

interface Props {
  employees: Employee[];
  onChange: (employees: Employee[]) => void;
}

let nextId = 1;

export function EmployeeManager({ employees, onChange }: Props) {
  const ids = employees.map((e) => e.id);

  function update(id: string, patch: Partial<Employee>) {
    onChange(employees.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function remove(id: string) {
    onChange(employees.filter((e) => e.id !== id));
  }

  function add() {
    onChange([...employees, { id: `new-${Date.now()}-${nextId++}`, name: 'Nový zaměstnanec', type: 'parttime' }]);
  }

  return (
    <section className="panel">
      <h2>Zaměstnanci</h2>
      <ul className="employee-list">
        {employees.map((emp) => (
          <li key={emp.id} className="employee-row">
            <span className="color-dot" style={{ background: employeeColor(emp.id, ids) }} />
            <input
              className="employee-name"
              value={emp.name}
              onChange={(e) => update(emp.id, { name: e.target.value })}
            />
            <select
              value={emp.type}
              onChange={(e) => update(emp.id, { type: e.target.value as EmployeeType })}
            >
              <option value="fulltime">Plný úvazek</option>
              <option value="parttime">Poloviční úvazek</option>
            </select>
            <button type="button" className="icon-btn" onClick={() => remove(emp.id)} aria-label="Odebrat">
              ×
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary-btn" onClick={add}>
        + Přidat zaměstnance
      </button>
    </section>
  );
}
