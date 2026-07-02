import { useEffect, useMemo, useState } from 'react';
import type { Assignment, Employee, ShiftDefinition, UnavailabilityMap } from './types';
import { SHIFTS, WEEKEND_SHIFT } from './types';
import { computeWarnings, generateSchedule, totalHoursByEmployee } from './scheduler';
import type { SchedulesMap } from './storage';
import {
  DEFAULT_EMPLOYEES,
  loadEmployees,
  loadSchedules,
  loadUnavailability,
  monthKey,
  saveEmployees,
  saveSchedules,
  saveUnavailability,
} from './storage';
import { EmployeeManager } from './components/EmployeeManager';
import { WarningsPanel } from './components/WarningsPanel';
import { HoursSummary } from './components/HoursSummary';
import { CalendarGrid } from './components/CalendarGrid';
import { AvailabilityGrid } from './components/AvailabilityGrid';
import './App.css';

const MONTH_NAMES = [
  'Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec',
];

function shiftForEmployee(employee: Employee, kind: ShiftDefinition['kind']): ShiftDefinition {
  if (kind === 'weekend') return WEEKEND_SHIFT;
  return SHIFTS[employee.type][kind];
}

function App() {
  const today = new Date();
  const [employees, setEmployees] = useState<Employee[]>(() => loadEmployees() ?? DEFAULT_EMPLOYEES);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [schedules, setSchedules] = useState<SchedulesMap>(() => loadSchedules());
  const [unavailability, setUnavailability] = useState<UnavailabilityMap>(() => loadUnavailability());

  useEffect(() => saveEmployees(employees), [employees]);
  useEffect(() => saveSchedules(schedules), [schedules]);
  useEffect(() => saveUnavailability(unavailability), [unavailability]);

  const key = monthKey(year, month);
  const assignments = useMemo(() => schedules[key] ?? [], [schedules, key]);

  const warnings = useMemo(
    () => computeWarnings(year, month, employees, assignments),
    [year, month, employees, assignments],
  );
  const hoursByEmployee = useMemo(() => totalHoursByEmployee(assignments, employees), [assignments, employees]);

  function setAssignments(next: Assignment[]) {
    setSchedules((prev) => ({ ...prev, [key]: next }));
  }

  function handleGenerate() {
    if (assignments.length > 0) {
      const confirmed = window.confirm('Pro tento měsíc už existuje rozvrh. Vygenerovat znovu a přepsat ruční úpravy?');
      if (!confirmed) return;
    }
    setAssignments(generateSchedule(year, month, employees, unavailability));
  }

  function handleToggleUnavailable(employeeId: string, iso: string) {
    setUnavailability((prev) => {
      const current = new Set(prev[employeeId] ?? []);
      if (current.has(iso)) current.delete(iso);
      else current.add(iso);
      return { ...prev, [employeeId]: current };
    });
  }

  function handleUpdateAssignmentEmployee(index: number, newEmployeeId: string) {
    const employee = employees.find((e) => e.id === newEmployeeId);
    if (!employee) return;
    const next = assignments.map((a, i) =>
      i === index ? { ...a, employeeId: newEmployeeId, shift: shiftForEmployee(employee, a.shift.kind) } : a,
    );
    setAssignments(next);
  }

  function handleRemoveAssignment(index: number) {
    setAssignments(assignments.filter((_, i) => i !== index));
  }

  function handleAddAssignment(date: string, employeeId: string, shift: ShiftDefinition) {
    setAssignments([...assignments, { date, employeeId, shift }]);
  }

  function changeMonth(delta: number) {
    let newMonth = month + delta;
    let newYear = year;
    if (newMonth < 0) {
      newMonth = 11;
      newYear -= 1;
    } else if (newMonth > 11) {
      newMonth = 0;
      newYear += 1;
    }
    setMonth(newMonth);
    setYear(newYear);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Plánovač směn</h1>
        <div className="month-nav">
          <button type="button" className="icon-btn" onClick={() => changeMonth(-1)} aria-label="Předchozí měsíc">
            ‹
          </button>
          <span className="month-label">
            {MONTH_NAMES[month]} {year}
          </span>
          <button type="button" className="icon-btn" onClick={() => changeMonth(1)} aria-label="Další měsíc">
            ›
          </button>
          <button type="button" className="primary-btn" onClick={handleGenerate}>
            {assignments.length > 0 ? 'Vygenerovat znovu' : 'Vygenerovat rozvrh'}
          </button>
        </div>
      </header>

      <div className="app-layout">
        <aside className="sidebar">
          <EmployeeManager employees={employees} onChange={setEmployees} />
          <WarningsPanel warnings={warnings} />
          <HoursSummary employees={employees} hoursByEmployee={hoursByEmployee} />
        </aside>

        <main className="main-content">
          <AvailabilityGrid
            year={year}
            month={month}
            employees={employees}
            unavailability={unavailability}
            onToggle={handleToggleUnavailable}
          />
        </main>
      </div>

      {assignments.length === 0 ? (
        <section className="panel">
          <p className="muted">Pro tento měsíc zatím není žádný rozvrh. Klikněte na „Vygenerovat rozvrh“.</p>
        </section>
      ) : (
        <CalendarGrid
          year={year}
          month={month}
          employees={employees}
          assignments={assignments}
          onUpdateAssignmentEmployee={handleUpdateAssignmentEmployee}
          onRemoveAssignment={handleRemoveAssignment}
          onAddAssignment={handleAddAssignment}
        />
      )}
    </div>
  );
}

export default App;
