import { useState } from 'react';
import type { Assignment, Employee, ShiftDefinition } from '../types';
import { daysInMonth, shiftOptionsFor, toISODate } from '../scheduler';
import { employeeColor } from '../colors';

interface Props {
  year: number;
  month: number;
  employees: Employee[];
  assignments: Assignment[];
  onUpdateAssignmentEmployee: (index: number, newEmployeeId: string) => void;
  onUpdateAssignmentTime: (index: number, field: 'start' | 'end', value: string) => void;
  onRemoveAssignment: (index: number) => void;
  onAddAssignment: (date: string, employeeId: string, shift: ShiftDefinition) => void;
}

const WEEKDAY_LABELS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
const SHIFT_LABELS: Record<ShiftDefinition['kind'], string> = {
  morning: 'Ranní',
  afternoon: 'Odpolední',
  weekend: 'Víkendová',
};

function AddShiftRow({
  employees,
  isWeekend,
  onAdd,
}: {
  employees: Employee[];
  isWeekend: boolean;
  onAdd: (employeeId: string, shift: ShiftDefinition) => void;
}) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const employee = employees.find((e) => e.id === employeeId) ?? employees[0];
  const options = employee ? shiftOptionsFor(employee, isWeekend) : [];
  const [shiftKind, setShiftKind] = useState(options[0]?.kind ?? 'morning');

  if (!employee) return null;
  const currentOptions = shiftOptionsFor(employee, isWeekend);
  const selectedShift = currentOptions.find((s) => s.kind === shiftKind) ?? currentOptions[0];

  return (
    <div className="add-shift-row">
      <select
        value={employeeId}
        onChange={(e) => setEmployeeId(e.target.value)}
        aria-label="Vybrat zaměstnance"
      >
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      {currentOptions.length > 1 && (
        <select value={shiftKind} onChange={(e) => setShiftKind(e.target.value as ShiftDefinition['kind'])}>
          {currentOptions.map((s) => (
            <option key={s.kind} value={s.kind}>
              {SHIFT_LABELS[s.kind]}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="icon-btn"
        title="Přidat směnu"
        onClick={() => selectedShift && onAdd(employee.id, selectedShift)}
      >
        +
      </button>
    </div>
  );
}

export function CalendarGrid({
  year,
  month,
  employees,
  assignments,
  onUpdateAssignmentEmployee,
  onUpdateAssignmentTime,
  onRemoveAssignment,
  onAddAssignment,
}: Props) {
  const totalDays = daysInMonth(year, month);
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const indexed = assignments.map((a, i) => ({ a, i }));

  return (
    <section className="panel calendar-panel">
      <div className="calendar-grid">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="calendar-header-cell">
            {label}
          </div>
        ))}
        {cells.map((day, idx) => {
          if (day === null) return <div key={idx} className="calendar-cell empty" />;
          const date = new Date(year, month, day);
          const iso = toISODate(date);
          const dow = date.getDay();
          const isWeekend = dow === 0 || dow === 6;
          const dayItems = indexed
            .filter((x) => x.a.date === iso)
            .sort((x, y) => x.a.shift.start.localeCompare(y.a.shift.start));

          return (
            <div key={idx} className={`calendar-cell${isWeekend ? ' weekend' : ''}`}>
              <div className="calendar-cell-date">{day}</div>
              <div className="calendar-cell-shifts">
                {dayItems.map(({ a, i }) => (
                  <div key={i} className="shift-block" style={{ borderColor: employeeColor(a.employeeId, employees) }}>
                    <div className="shift-time-row">
                      <span className="shift-kind-label">{SHIFT_LABELS[a.shift.kind]}</span>
                      <input
                        type="time"
                        className="shift-time-input"
                        value={a.shift.start}
                        onChange={(e) => onUpdateAssignmentTime(i, 'start', e.target.value)}
                        aria-label="Začátek směny"
                      />
                      <span>–</span>
                      <input
                        type="time"
                        className="shift-time-input"
                        value={a.shift.end}
                        onChange={(e) => onUpdateAssignmentTime(i, 'end', e.target.value)}
                        aria-label="Konec směny"
                      />
                      <span className="shift-hours-label">{a.shift.hours.toFixed(1)} h</span>
                    </div>
                    <div className="shift-employee-row">
                      <select
                        value={a.employeeId}
                        onChange={(e) => onUpdateAssignmentEmployee(i, e.target.value)}
                        style={{ color: employeeColor(a.employeeId, employees) }}
                      >
                        {employees.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Odebrat směnu"
                        onClick={() => onRemoveAssignment(i)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {employees.length > 0 && (
                <AddShiftRow
                  employees={employees}
                  isWeekend={isWeekend}
                  onAdd={(employeeId, shift) => onAddAssignment(iso, employeeId, shift)}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
