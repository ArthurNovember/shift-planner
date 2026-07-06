import { useState } from 'react';
import type { Assignment, Employee, ShiftDefinition } from '../types';
import { daysInMonth, hoursBetween, shiftOptionsFor, toISODate } from '../scheduler';
import { employeeColor } from '../colors';
import { getCzechHolidays } from '../holidays';

interface Props {
  year: number;
  month: number;
  employees: Employee[];
  assignments: Assignment[];
  onUpdateAssignmentEmployee: (index: number, newEmployeeId: string) => void;
  onUpdateAssignmentKind: (index: number, kind: 'morning' | 'afternoon') => void;
  onUpdateAssignmentTime: (index: number, field: 'start' | 'end', value: string) => void;
  onToggleBreak: (index: number) => void;
  onRemoveAssignment: (index: number) => void;
  onAddAssignment: (date: string, employeeId: string, shift: ShiftDefinition) => void;
  highlightedDate?: string | null;
}

const WEEKDAY_LABELS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
const SHIFT_LABELS: Record<ShiftDefinition['kind'], string> = {
  morning: 'Ranní',
  afternoon: 'Odpolední',
  weekend: 'Víkendová',
  holiday: 'Svátek',
};

function AddShiftRow({
  employees,
  isWeekend,
  isHoliday,
  onAdd,
}: {
  employees: Employee[];
  isWeekend: boolean;
  isHoliday: boolean;
  onAdd: (employeeId: string, shift: ShiftDefinition) => void;
}) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const employee = employees.find((e) => e.id === employeeId) ?? employees[0];
  const options = employee ? shiftOptionsFor(employee, isWeekend, isHoliday) : [];
  const [shiftKind, setShiftKind] = useState(options[0]?.kind ?? 'morning');

  if (!employee) return null;
  const currentOptions = shiftOptionsFor(employee, isWeekend, isHoliday);
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
  onUpdateAssignmentKind,
  onUpdateAssignmentTime,
  onToggleBreak,
  onRemoveAssignment,
  onAddAssignment,
  highlightedDate,
}: Props) {
  const totalDays = daysInMonth(year, month);
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
  const todayIso = toISODate(new Date());
  const holidays = getCzechHolidays(year);

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

          const isToday = iso === todayIso;
          const isHighlighted = iso === highlightedDate;
          const holidayName = holidays.get(iso);
          const isHoliday = !isWeekend && !!holidayName;

          return (
            <div
              key={idx}
              id={`day-${iso}`}
              className={`calendar-cell${isWeekend ? ' weekend' : ''}${isHoliday ? ' holiday' : ''}${isToday ? ' today' : ''}${isHighlighted ? ' highlighted' : ''}`}
            >
              <div className="calendar-cell-date">
                <span className="calendar-cell-weekday">{WEEKDAY_LABELS[(dow + 6) % 7]}</span>
                {day}
              </div>
              {holidayName && <div className="calendar-cell-holiday-name">{holidayName}</div>}
              <div className="calendar-cell-shifts">
                {dayItems.map(({ a, i }) => {
                  const duration = hoursBetween(a.shift.start, a.shift.end);
                  const eligibleForBreak = duration > 6;
                  const hasBreak = (a.shift.breakMinutes ?? 0) > 0;
                  return (
                  <div key={i} className="shift-block" style={{ borderColor: employeeColor(a.employeeId, employees) }}>
                    <div className="shift-time-row">
                      {a.shift.kind === 'weekend' || a.shift.kind === 'holiday' ? (
                        <span className="shift-kind-label">{SHIFT_LABELS[a.shift.kind]}</span>
                      ) : (
                        <select
                          className="shift-kind-select"
                          value={a.shift.kind}
                          onChange={(e) => onUpdateAssignmentKind(i, e.target.value as 'morning' | 'afternoon')}
                          aria-label="Typ směny"
                        >
                          <option value="morning">Ranní</option>
                          <option value="afternoon">Odpolední</option>
                        </select>
                      )}
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
                    {eligibleForBreak && (
                      <label
                        className={`break-toggle${hasBreak ? ' checked' : ''}`}
                        title={
                          hasBreak
                            ? 'Směna delší než 6 h má 30min pauzu na oběd, která se nepočítá do odpracovaných hodin - odškrtnutím ji odeberete.'
                            : 'Směna delší než 6 h má nárok na 30min pauzu na oběd, která se nepočítá do odpracovaných hodin - zaškrtnutím ji přidáte.'
                        }
                      >
                        <input type="checkbox" checked={hasBreak} onChange={() => onToggleBreak(i)} />
                        Oběd (30 min)
                      </label>
                    )}
                    <div className="shift-employee-row">
                      <select
                        value={a.employeeId}
                        onChange={(e) => onUpdateAssignmentEmployee(i, e.target.value)}
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
                  );
                })}
              </div>
              {employees.length > 0 && (
                <AddShiftRow
                  employees={employees}
                  isWeekend={isWeekend}
                  isHoliday={isHoliday}
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
