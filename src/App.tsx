import { useEffect, useMemo, useState } from "react";
import type {
  Assignment,
  AvailabilityKind,
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
  hasCloudData,
  hasLocalData,
  loadEmployees,
  loadLocalSnapshot,
  loadSchedules,
  loadTheme,
  loadUnavailability,
  monthKey,
  saveEmployees,
  saveSchedules,
  saveTheme,
  saveUnavailability,
} from "./storage";
import { supabase } from "./supabaseClient";
import { LoginGate } from "./components/LoginGate";
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

function AppContent() {
  const today = new Date();
  const [employees, setEmployees] = useState<Employee[]>(DEFAULT_EMPLOYEES);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [schedules, setSchedules] = useState<SchedulesMap>({});
  const [unavailability, setUnavailability] = useState<UnavailabilityMap>({});
  const [ptLongShortWeek, setPtLongShortWeek] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(false);

  // One-time load from the shared cloud storage on login. If the cloud is still empty but this
  // browser has real data from before the switch to cloud storage, offer to upload it instead of
  // silently starting from an empty state.
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const cloudHasData = await hasCloudData();
        if (!cloudHasData && hasLocalData()) {
          const snapshot = loadLocalSnapshot();
          const confirmed = window.confirm(
            "V tomto prohlížeči byla nalezena starší data rozvrhu. Nahrát je do cloudu, aby je viděli všichni?",
          );
          if (confirmed) {
            await Promise.all([
              saveEmployees(snapshot.employees),
              saveSchedules(snapshot.schedules),
              saveUnavailability(snapshot.unavailability),
            ]);
            if (cancelled) return;
            setEmployees(snapshot.employees);
            setSchedules(snapshot.schedules);
            setUnavailability(snapshot.unavailability);
            return;
          }
        }
        const [emp, sched, unavail] = await Promise.all([loadEmployees(), loadSchedules(), loadUnavailability()]);
        if (cancelled) return;
        setEmployees(emp);
        setSchedules(sched);
        setUnavailability(unavail);
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    saveEmployees(employees)
      .then(() => setSaveError(false))
      .catch(() => setSaveError(true));
  }, [employees, loaded]);
  useEffect(() => {
    if (!loaded) return;
    saveSchedules(schedules)
      .then(() => setSaveError(false))
      .catch(() => setSaveError(true));
  }, [schedules, loaded]);
  useEffect(() => {
    saveTheme(theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!loaded) return;
    saveUnavailability(unavailability)
      .then(() => setSaveError(false))
      .catch(() => setSaveError(true));
  }, [unavailability, loaded]);

  const key = monthKey(year, month);
  const assignments = useMemo(() => schedules[key] ?? [], [schedules, key]);

  const warnings = useMemo(
    () => computeWarnings(year, month, employees, assignments, unavailability),
    [year, month, employees, assignments, unavailability],
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
    const workingIds = new Set(
      todaySchedule
        .filter((a) => a.date === todayISO && a.shift.start <= nowTime && nowTime <= a.shift.end)
        .map((a) => a.employeeId),
    );
    return employees
      .filter((e) => workingIds.has(e.id))
      .map((e) => ({ id: e.id, color: employeeColor(e.id, employees) }));
  }, [schedules, employees]);

  const todayAssignments = useMemo(() => {
    const now = new Date();
    const todayKey = monthKey(now.getFullYear(), now.getMonth());
    const todaySchedule = schedules[todayKey] ?? [];
    const todayISO = toISODate(now);
    return todaySchedule.filter((a) => a.date === todayISO);
  }, [schedules]);

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
    const previousMonth = month === 0 ? 11 : month - 1;
    const previousYear = month === 0 ? year - 1 : year;
    const previousAssignments = schedules[monthKey(previousYear, previousMonth)] ?? [];
    setAssignments(
      generateSchedule(
        year,
        month,
        employees,
        unavailability,
        { ptLongShortWeek },
        previousAssignments,
      ),
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

  function handleToggleUnavailable(
    employeeId: string,
    iso: string,
    kind?: AvailabilityKind,
  ) {
    setUnavailability((prev) => {
      const employeeDays = prev[employeeId] ?? {};
      const current = employeeDays[iso] ?? new Set<AvailabilityKind>();
      let next: Set<AvailabilityKind>;
      if (kind) {
        next = new Set(current);
        if (next.has(kind)) next.delete(kind);
        else next.add(kind);
      } else {
        // No specific kind (weekend day): toggle the whole day off at once.
        const bothBlocked = current.has("morning") && current.has("afternoon");
        next = bothBlocked ? new Set() : new Set(["morning", "afternoon"]);
      }
      const nextDays = { ...employeeDays };
      if (next.size === 0) delete nextDays[iso];
      else nextDays[iso] = next;
      return { ...prev, [employeeId]: nextDays };
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

  if (!loaded) {
    return (
      <div className="auth-screen">
        <p className="muted">Načítání…</p>
      </div>
    );
  }

  return (
    <div className="app">
      {saveError && (
        <div className="save-error-banner">
          Nepodařilo se uložit změny. Zkontrolujte připojení k internetu.
        </div>
      )}
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
          <label
            className="regularity-toggle"
            title="Víkend se počítá jako 19 h, zbylých ~61 h do 80h stropu se rovnoměrně rozloží do týdnů v měsíci"
          >
            Dlouhý/krátký týden pro poloviční úvazek
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={ptLongShortWeek}
              aria-label="Dlouhý/krátký týden pro poloviční úvazek"
              onClick={() => setPtLongShortWeek(!ptLongShortWeek)}
            >
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
            </button>
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
          <HoursSummary
            employees={employees}
            hoursByEmployee={hoursByEmployee}
          />
        </aside>

        <main className="main-content">
          <SpaceScene
            workingEmployees={workingEmployees}
            employees={employees}
            todayAssignments={todayAssignments}
          />
        </main>

        <aside className="warnings-column">
          <WarningsPanel warnings={warnings} />
        </aside>
      </div>

      <AvailabilityGrid
        year={year}
        month={month}
        employees={employees}
        unavailability={unavailability}
        onToggle={handleToggleUnavailable}
      />

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
        <button
          type="button"
          className="secondary-btn"
          onClick={() => supabase.auth.signOut()}
        >
          Odhlásit
        </button>
      </footer>
    </div>
  );
}

function App() {
  return (
    <LoginGate>
      <AppContent />
    </LoginGate>
  );
}

export default App;
