import { useEffect, useState } from 'react';
import type { Employee, EmployeeType } from '../types';
import { employeeColor, PALETTE } from '../colors';

interface Props {
  employees: Employee[];
  onChange: (employees: Employee[]) => void;
}

let nextId = 1;

export function EmployeeManager({ employees, onChange }: Props) {
  const [pickerOpenFor, setPickerOpenFor] = useState<string | null>(null);

  useEffect(() => {
    if (!pickerOpenFor) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('.color-picker-wrapper')) setPickerOpenFor(null);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [pickerOpenFor]);

  function update(id: string, patch: Partial<Employee>) {
    onChange(employees.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function remove(id: string) {
    onChange(employees.filter((e) => e.id !== id));
  }

  function add() {
    onChange([...employees, { id: `new-${Date.now()}-${nextId++}`, name: 'Nový zaměstnanec', type: 'parttime' }]);
  }

  function pickColor(id: string, color: string | undefined) {
    update(id, { color });
    setPickerOpenFor(null);
  }

  // Native color input fires onChange continuously while dragging inside the picker, so this
  // doesn't close the popover like picking a swatch does - only a deliberate click (a swatch,
  // the dot again, or elsewhere) closes it.
  function updateCustomColor(id: string, color: string) {
    update(id, { color });
  }

  return (
    <section className="panel">
      <h2>Zaměstnanci</h2>
      <ul className="employee-list">
        {employees.map((emp) => (
          <li key={emp.id} className="employee-row">
            <span className="color-picker-wrapper">
              <button
                type="button"
                className="color-dot color-dot-btn"
                style={{ background: employeeColor(emp.id, employees) }}
                onClick={() => setPickerOpenFor(pickerOpenFor === emp.id ? null : emp.id)}
                aria-label={`Vybrat barvu pro ${emp.name}`}
              />
              {pickerOpenFor === emp.id && (
                <div className="color-picker-popover">
                  <div className="color-swatch-row">
                    {PALETTE.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className="color-swatch"
                        style={{ background: color }}
                        onClick={() => pickColor(emp.id, color)}
                        aria-label={`Barva ${color}`}
                      />
                    ))}
                  </div>
                  <label className="color-custom-row">
                    <input
                      type="color"
                      className="color-input"
                      value={emp.color ?? '#000000'}
                      onChange={(e) => updateCustomColor(emp.id, e.target.value)}
                      aria-label={`Vlastní barva pro ${emp.name}`}
                    />
                    Vlastní odstín
                  </label>
                  <button type="button" className="color-swatch-reset" onClick={() => pickColor(emp.id, undefined)}>
                    Výchozí
                  </button>
                </div>
              )}
            </span>
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
