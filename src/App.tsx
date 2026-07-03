import { useEffect, useMemo, useState } from "react";
import type {
  Assignment,
  Employee,
  ShiftDefinition,
  UnavailabilityMap,
} from "./types";
import { SHIFTS, WEEKEND_SHIFT } from "./types";
import {
  computeWarnings,
  generateSchedule,
  hoursBetween,
  toISODate,
  totalHoursByEmployee,
} from "./scheduler";
import { employeeColor } from "./colors";
import type { SchedulesMap, Theme } from "./storage";
import {
  DEFAULT_EMPLOYEES,
  loadEmployees,
  loadSchedules,
  loadTheme,
  loadUnavailability,
  monthKey,
  saveEmployees,
  saveSchedules,
  saveTheme,
  saveUnavailability,
} from "./storage";
import { EmployeeManager } from "./components/EmployeeManager";
import { WarningsPanel } from "./components/WarningsPanel";
import { HoursSummary } from "./components/HoursSummary";
import { CalendarGrid } from "./components/CalendarGrid";
import { AvailabilityGrid } from "./components/AvailabilityGrid";
import { SpaceScene } from "./components/SpaceScene";
import "./App.css";

const MONTH_NAMES = [
  "Leden",
  "Únor",
  "Březen",
  "Duben",
  "Květen",
  "Červen",
  "Červenec",
  "Srpen",
  "Září",
  "Říjen",
  "Listopad",
  "Prosinec",
];

function shiftForEmployee(
  employee: Employee,
  kind: ShiftDefinition["kind"],
): ShiftDefinition {
  if (kind === "weekend") return WEEKEND_SHIFT;
  return SHIFTS[employee.type][kind];
}

function App() {
  const today = new Date();
  const [employees, setEmployees] = useState<Employee[]>(
    () => loadEmployees() ?? DEFAULT_EMPLOYEES,
  );
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [schedules, setSchedules] = useState<SchedulesMap>(() =>
    loadSchedules(),
  );
  const [unavailability, setUnavailability] = useState<UnavailabilityMap>(() =>
    loadUnavailability(),
  );
  const [ptRegularityMode, setPtRegularityMode] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  useEffect(() => saveEmployees(employees), [employees]);
  useEffect(() => saveSchedules(schedules), [schedules]);
  useEffect(() => {
    saveTheme(theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  useEffect(() => saveUnavailability(unavailability), [unavailability]);

  const key = monthKey(year, month);
  const assignments = useMemo(() => schedules[key] ?? [], [schedules, key]);

  const warnings = useMemo(
    () => computeWarnings(year, month, employees, assignments),
    [year, month, employees, assignments],
  );
  const hoursByEmployee = useMemo(
    () => totalHoursByEmployee(assignments, employees),
    [assignments, employees],
  );

  const workingEmployees = useMemo(() => {
    const now = new Date();
    const todayKey = monthKey(now.getFullYear(), now.getMonth());
    const todaySchedule = schedules[todayKey] ?? [];
    const todayISO = toISODate(now);
    const nowTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const employeeIds = employees.map((e) => e.id);
    const workingIds = new Set(
      todaySchedule
        .filter((a) => a.date === todayISO && a.shift.start <= nowTime && nowTime <= a.shift.end)
        .map((a) => a.employeeId),
    );
    return employees
      .filter((e) => workingIds.has(e.id))
      .map((e) => ({ id: e.id, color: employeeColor(e.id, employeeIds) }));
  }, [schedules, employees]);

  function setAssignments(next: Assignment[]) {
    setSchedules((prev) => ({ ...prev, [key]: next }));
  }

  function handleGenerate() {
    if (assignments.length > 0) {
      const confirmed = window.confirm(
        "Pro tento měsíc už existuje rozvrh. Vygenerovat znovu a přepsat ruční úpravy?",
      );
      if (!confirmed) return;
    }
    setAssignments(
      generateSchedule(year, month, employees, unavailability, {
        ptRegularityMode,
      }),
    );
  }

  function handleExportPdf() {
    import("./pdfExport")
      .then(({ exportScheduleToPdf }) =>
        exportScheduleToPdf(year, month, employees, assignments),
      )
      .catch(() => {
        window.alert("Export do PDF se nezdařil. Zkuste to prosím znovu.");
      });
  }

  function handleToggleUnavailable(employeeId: string, iso: string) {
    setUnavailability((prev) => {
      const current = new Set(prev[employeeId] ?? []);
      if (current.has(iso)) current.delete(iso);
      else current.add(iso);
      return { ...prev, [employeeId]: current };
    });
  }

  function handleUpdateAssignmentEmployee(
    index: number,
    newEmployeeId: string,
  ) {
    const employee = employees.find((e) => e.id === newEmployeeId);
    if (!employee) return;
    const next = assignments.map((a, i) =>
      i === index
        ? {
            ...a,
            employeeId: newEmployeeId,
            shift: shiftForEmployee(employee, a.shift.kind),
          }
        : a,
    );
    setAssignments(next);
  }

  function handleUpdateAssignmentTime(
    index: number,
    field: "start" | "end",
    value: string,
  ) {
    if (!value) return;
    const next = assignments.map((a, i) => {
      if (i !== index) return a;
      const start = field === "start" ? value : a.shift.start;
      const end = field === "end" ? value : a.shift.end;
      return {
        ...a,
        shift: { ...a.shift, start, end, hours: hoursBetween(start, end) },
      };
    });
    setAssignments(next);
  }

  function handleRemoveAssignment(index: number) {
    setAssignments(assignments.filter((_, i) => i !== index));
  }

  function handleAddAssignment(
    date: string,
    employeeId: string,
    shift: ShiftDefinition,
  ) {
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
        <div>
          <h1>
            Plánovač <span className="accent">směn</span>
          </h1>

          <span className="app-subtitle">Planetum · e-shop</span>
        </div>
        <div className="month-nav">
          <button
            type="button"
            className="icon-btn"
            onClick={() => changeMonth(-1)}
            aria-label="Předchozí měsíc"
          >
            ‹
          </button>
          <span className="month-label">
            {MONTH_NAMES[month]} {year}
          </span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => changeMonth(1)}
            aria-label="Další měsíc"
          >
            ›
          </button>
          <label className="regularity-toggle">
            <input
              type="checkbox"
              checked={ptRegularityMode}
              onChange={(e) => setPtRegularityMode(e.target.checked)}
            />
            Pravidelné směny pro poloviční úvazek
          </label>
          <button
            type="button"
            className="secondary-btn"
            onClick={handleExportPdf}
            disabled={assignments.length === 0}
          >
            Stáhnout PDF
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={handleGenerate}
          >
            {assignments.length > 0
              ? "Vygenerovat znovu"
              : "Vygenerovat rozvrh"}
          </button>
        </div>
      </header>

      <div className="app-layout">
        <aside className="sidebar">
          <EmployeeManager employees={employees} onChange={setEmployees} />
          <WarningsPanel warnings={warnings} />
          <HoursSummary
            employees={employees}
            hoursByEmployee={hoursByEmployee}
          />
        </aside>

        <main className="main-content">
          <AvailabilityGrid
            year={year}
            month={month}
            employees={employees}
            unavailability={unavailability}
            onToggle={handleToggleUnavailable}
          />
          <SpaceScene workingEmployees={workingEmployees} />
        </main>
      </div>

      {assignments.length === 0 ? (
        <section className="panel">
          <p className="muted">
            Pro tento měsíc zatím není žádný rozvrh. Klikněte na „Vygenerovat
            rozvrh“.
          </p>
        </section>
      ) : (
        <CalendarGrid
          year={year}
          month={month}
          employees={employees}
          assignments={assignments}
          onUpdateAssignmentEmployee={handleUpdateAssignmentEmployee}
          onUpdateAssignmentTime={handleUpdateAssignmentTime}
          onRemoveAssignment={handleRemoveAssignment}
          onAddAssignment={handleAddAssignment}
        />
      )}

      <footer className="app-footer">
        <span className="theme-toggle-label">
          {theme === "light" ? "Světlý režim" : "Tmavý režim"}
        </span>
        <button
          type="button"
          className="theme-toggle"
          role="switch"
          aria-checked={theme === "light"}
          aria-label="Přepnout světlý/tmavý režim"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          <span className="theme-toggle-track">
            <span className="theme-toggle-thumb" />
          </span>
        </button>
      </footer>
    </div>
  );
}

export default App;
