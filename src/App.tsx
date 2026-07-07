import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Assignment,
  AvailabilityKind,
  Employee,
  ShiftDefinition,
  UnavailabilityMap,
} from "./types";
import { HOLIDAY_SHIFT, SHIFTS, WEEKEND_SHIFT } from "./types";
import {
  computeWarnings,
  generateSchedule,
  hoursBetween,
  toISODate,
  totalHoursByEmployee,
} from "./scheduler";
import { employeeColor } from "./colors";
import type { DismissedWarningsMap, HistoryMap, HistorySeenMap, SchedulesMap, Theme } from "./storage";
import {
  DEFAULT_EMPLOYEES,
  hasCloudData,
  hasLocalData,
  loadDismissedWarnings,
  loadEmployees,
  loadHistory,
  loadHistorySeen,
  loadLocalSnapshot,
  loadSchedules,
  loadTheme,
  loadUnavailability,
  markHistorySeen,
  monthKey,
  saveDismissedWarnings,
  saveEmployees,
  saveHistory,
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
import { HistoryPanel } from "./components/HistoryPanel";
import "./App.css";

const SHIFT_KIND_LABELS: Record<ShiftDefinition["kind"], string> = {
  morning: "ranní",
  afternoon: "odpolední",
  weekend: "víkendová",
  holiday: "sváteční",
};

function formatHistoryDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d}. ${m}.`;
}

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
  if (kind === "holiday") return HOLIDAY_SHIFT;
  return SHIFTS[employee.type][kind];
}

function AppContent() {
  const today = new Date();
  const [employees, setEmployees] = useState<Employee[]>(DEFAULT_EMPLOYEES);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [schedules, setSchedules] = useState<SchedulesMap>({});
  const [unavailability, setUnavailability] = useState<UnavailabilityMap>({});
  const [dismissedWarnings, setDismissedWarnings] = useState<DismissedWarningsMap>({});
  const [history, setHistory] = useState<HistoryMap>({});
  const [historySeen, setHistorySeen] = useState<HistorySeenMap>(() => loadHistorySeen());
  const [ptLongShortWeek, setPtLongShortWeek] = useState(false);
  const [icsEmployeeId, setIcsEmployeeId] = useState("all");
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveError, setSaveError] = useState(false);
  const [highlightedDate, setHighlightedDate] = useState<string | null>(null);
  const [preGenerateSnapshot, setPreGenerateSnapshot] = useState<{ key: string; assignments: Assignment[] } | null>(
    null,
  );
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarHeight, setSidebarHeight] = useState<number | undefined>(undefined);

  // The sidebar (employees + hours-per-month) is the reference height on desktop: the space
  // scene should end exactly where it does, and the warnings panel should be at least that tall
  // too - but only as a floor, since a long warnings list shouldn't stretch the sidebar or space
  // scene along with it. A plain CSS stretch can't express "match, but only one-way", so this
  // measures the sidebar's actual rendered height and applies it directly.
  useEffect(() => {
    if (!sidebarRef.current) return;
    const el = sidebarRef.current;
    const observer = new ResizeObserver((entries) => {
      setSidebarHeight(entries[0]?.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loaded]);

  // One-time load from the shared cloud storage on login. If the cloud is still empty but this
  // browser has real data from before the switch to cloud storage, offer to upload it instead of
  // silently starting from an empty state.
  //
  // Critical: `loaded` must only ever become true once the real data has actually been fetched
  // and applied to state - the save-effects below are gated on it, and fire the moment it flips.
  // If a load fails partway (e.g. a transient network hiccup, or a table that briefly didn't
  // exist yet) and `loaded` were set anyway, those save-effects would immediately persist
  // whatever's still sitting in the initial default state (empty schedules, default employees)
  // straight over the real cloud data, wiping it out. So on any failure here, `loaded` simply
  // never gets set - the app stays on the loading screen with a retry option instead.
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
            setLoaded(true);
            return;
          }
        }
        const [emp, sched, unavail, dismissed, hist] = await Promise.all([
          loadEmployees(),
          loadSchedules(),
          loadUnavailability(),
          loadDismissedWarnings(),
          loadHistory(),
        ]);
        if (cancelled) return;
        setEmployees(emp);
        setSchedules(sched);
        setUnavailability(unavail);
        setDismissedWarnings(dismissed);
        setHistory(hist);
        setLoaded(true);
      } catch (err) {
        console.error(err);
        if (!cancelled) setLoadError(true);
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

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
  useEffect(() => {
    if (!loaded) return;
    saveDismissedWarnings(dismissedWarnings)
      .then(() => setSaveError(false))
      .catch(() => setSaveError(true));
  }, [dismissedWarnings, loaded]);
  useEffect(() => {
    if (!loaded) return;
    saveHistory(history)
      .then(() => setSaveError(false))
      .catch(() => setSaveError(true));
  }, [history, loaded]);

  const key = monthKey(year, month);
  const assignments = useMemo(() => schedules[key] ?? [], [schedules, key]);

  const monthHistory = useMemo(() => history[key] ?? [], [history, key]);
  const hasUnseenHistory = useMemo(() => {
    if (monthHistory.length === 0) return false;
    const lastSeen = historySeen[key];
    const newest = monthHistory[monthHistory.length - 1].timestamp;
    return !lastSeen || newest > lastSeen;
  }, [monthHistory, historySeen, key]);

  function appendHistory(targetKey: string, message: string) {
    setHistory((prev) => {
      const entries = prev[targetKey] ?? [];
      return { ...prev, [targetKey]: [...entries, { timestamp: new Date().toISOString(), message }] };
    });
  }

  function handleOpenHistory() {
    if (monthHistory.length === 0) return;
    const newest = monthHistory[monthHistory.length - 1].timestamp;
    setHistorySeen(markHistorySeen(key, newest));
  }

  const allWarnings = useMemo(
    () => computeWarnings(year, month, employees, assignments, unavailability),
    [year, month, employees, assignments, unavailability],
  );
  const dismissedForMonth = useMemo(() => dismissedWarnings[key] ?? [], [dismissedWarnings, key]);
  const warnings = useMemo(
    () => allWarnings.filter((w) => !dismissedForMonth.includes(w.message)),
    [allWarnings, dismissedForMonth],
  );
  const dismissedWarningObjects = useMemo(
    () => allWarnings.filter((w) => dismissedForMonth.includes(w.message)),
    [allWarnings, dismissedForMonth],
  );

  function handleDismissWarning(message: string) {
    setDismissedWarnings((prev) => {
      const current = prev[key] ?? [];
      if (current.includes(message)) return prev;
      return { ...prev, [key]: [...current, message] };
    });
  }

  function handleRestoreWarning(message: string) {
    setDismissedWarnings((prev) => {
      const current = prev[key] ?? [];
      return { ...prev, [key]: current.filter((m) => m !== message) };
    });
  }
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
    const hadExisting = assignments.length > 0;
    if (hadExisting) {
      const confirmed = window.confirm(
        "Pro tento měsíc už existuje rozvrh. Vygenerovat znovu a přepsat ruční úpravy?",
      );
      if (!confirmed) return;
    }
    const previousMonth = month === 0 ? 11 : month - 1;
    const previousYear = month === 0 ? year - 1 : year;
    const previousAssignments = schedules[monthKey(previousYear, previousMonth)] ?? [];
    setPreGenerateSnapshot(assignments.length > 0 ? { key, assignments } : null);
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
    appendHistory(key, hadExisting ? "Rozvrh byl vygenerován znovu." : "Rozvrh byl vygenerován.");
  }

  function handleRevertGenerate() {
    if (!preGenerateSnapshot || preGenerateSnapshot.key !== key) return;
    setAssignments(preGenerateSnapshot.assignments);
    setPreGenerateSnapshot(null);
    appendHistory(key, "Vygenerování rozvrhu bylo vráceno zpět.");
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

  function handleExportIcs() {
    import("./icsExport")
      .then(({ exportScheduleToIcs }) =>
        exportScheduleToIcs(
          year,
          month,
          employees,
          assignments,
          icsEmployeeId === "all" ? null : icsEmployeeId,
        ),
      )
      .catch(() => {
        window.alert("Export kalendáře se nezdařil. Zkuste to prosím znovu.");
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
    const previous = assignments[index];
    const previousEmployee = employees.find((e) => e.id === previous.employeeId);
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
    appendHistory(
      key,
      `Směna ${formatHistoryDay(previous.date)} přesunuta z ${previousEmployee?.name ?? "?"} na ${employee.name}.`,
    );
  }

  function handleUpdateAssignmentKind(index: number, kind: "morning" | "afternoon") {
    const a = assignments[index];
    const employee = employees.find((e) => e.id === a.employeeId);
    if (!employee) return;
    const next = assignments.map((x, i) => (i === index ? { ...x, shift: shiftForEmployee(employee, kind) } : x));
    setAssignments(next);
    appendHistory(
      key,
      `Změněn typ směny (${employee.name}, ${formatHistoryDay(a.date)}) na ${SHIFT_KIND_LABELS[kind]}.`,
    );
  }

  function handleUpdateAssignmentTime(
    index: number,
    field: "start" | "end",
    value: string,
  ) {
    if (!value) return;
    const a = assignments[index];
    const employee = employees.find((e) => e.id === a.employeeId);
    const next = assignments.map((a, i) => {
      if (i !== index) return a;
      const start = field === "start" ? value : a.shift.start;
      const end = field === "end" ? value : a.shift.end;
      const duration = hoursBetween(start, end);
      // A shift 6h or under never has a lunch break - shortening one below that threshold drops
      // it automatically, since it's no longer legally required. Growing it back past 6h doesn't
      // re-add a break on its own; that's the "+ oběd" toggle's job (see handleToggleBreak).
      const breakMinutes = duration > 6 ? (a.shift.breakMinutes ?? 0) : 0;
      return {
        ...a,
        shift: { ...a.shift, start, end, breakMinutes, hours: duration - breakMinutes / 60 },
      };
    });
    setAssignments(next);
    appendHistory(
      key,
      `Upraven ${field === "start" ? "začátek" : "konec"} směny (${employee?.name ?? "?"}, ${formatHistoryDay(a.date)}) na ${value}.`,
    );
  }

  function handleToggleBreak(index: number) {
    const target = assignments[index];
    const employee = employees.find((e) => e.id === target.employeeId);
    const addingBreak = (target.shift.breakMinutes ?? 0) === 0;
    const next = assignments.map((a, i) => {
      if (i !== index) return a;
      const duration = hoursBetween(a.shift.start, a.shift.end);
      const breakMinutes = (a.shift.breakMinutes ?? 0) > 0 ? 0 : 30;
      return {
        ...a,
        shift: { ...a.shift, breakMinutes, hours: duration - breakMinutes / 60 },
      };
    });
    setAssignments(next);
    appendHistory(
      key,
      `${addingBreak ? "Přidána" : "Odebrána"} pauza na oběd u směny (${employee?.name ?? "?"}, ${formatHistoryDay(target.date)}).`,
    );
  }

  function handleRemoveAssignment(index: number) {
    const target = assignments[index];
    const employee = employees.find((e) => e.id === target.employeeId);
    setAssignments(assignments.filter((_, i) => i !== index));
    appendHistory(key, `Odebrána směna: ${employee?.name ?? "?"}, ${formatHistoryDay(target.date)}.`);
  }

  function handleWarningClick(date: string) {
    document.getElementById(`day-${date}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedDate(date);
    setTimeout(() => setHighlightedDate(null), 2000);
  }

  function handleAddAssignment(
    date: string,
    employeeId: string,
    shift: ShiftDefinition,
  ) {
    const employee = employees.find((e) => e.id === employeeId);
    setAssignments([...assignments, { date, employeeId, shift }]);
    appendHistory(
      key,
      `Přidána směna: ${employee?.name ?? "?"}, ${formatHistoryDay(date)} (${SHIFT_KIND_LABELS[shift.kind]}).`,
    );
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

  if (loadError) {
    return (
      <div className="auth-screen">
        <div className="load-error">
          <p className="muted">
            Nepodařilo se načíst data z cloudu. Zkontrolujte připojení k internetu a zkuste to
            znovu - appka záměrně nic neukládá, dokud se data úspěšně nenačtou, ať se nic
            nepřepíše.
          </p>
          <button
            type="button"
            className="primary-btn"
            onClick={() => {
              setLoadError(false);
              setLoadAttempt((n) => n + 1);
            }}
          >
            Zkusit znovu
          </button>
        </div>
      </div>
    );
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
        <div className="app-header-left">
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
        </div>
        <div className="app-header-right">
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
        <aside className="sidebar" ref={sidebarRef}>
          <EmployeeManager employees={employees} onChange={setEmployees} />
          <HoursSummary
            employees={employees}
            hoursByEmployee={hoursByEmployee}
          />
        </aside>

        <main className="main-content" style={sidebarHeight ? { height: sidebarHeight } : undefined}>
          <div className="history-overlay">
            <HistoryPanel entries={monthHistory} hasUnseen={hasUnseenHistory} onOpen={handleOpenHistory} />
          </div>
          <SpaceScene
            workingEmployees={workingEmployees}
            employees={employees}
            todayAssignments={todayAssignments}
          />
        </main>

        <aside className="warnings-column">
          <WarningsPanel
            warnings={warnings}
            onWarningClick={handleWarningClick}
            minHeight={sidebarHeight}
            onDismiss={handleDismissWarning}
            dismissedWarnings={dismissedWarningObjects}
            onRestore={handleRestoreWarning}
          />
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
          onUpdateAssignmentKind={handleUpdateAssignmentKind}
          onUpdateAssignmentTime={handleUpdateAssignmentTime}
          onToggleBreak={handleToggleBreak}
          onRemoveAssignment={handleRemoveAssignment}
          onAddAssignment={handleAddAssignment}
          highlightedDate={highlightedDate}
        />
      )}

      <div className="export-bar">
        {preGenerateSnapshot?.key === key && (
          <button
            type="button"
            className="secondary-btn revert-generate-btn"
            onClick={handleRevertGenerate}
          >
            Vrátit předchozí rozvrh
          </button>
        )}
        <button
          type="button"
          className="secondary-btn"
          onClick={handleExportPdf}
          disabled={assignments.length === 0}
        >
          Stáhnout PDF
        </button>
        <span className="ics-export">
          <select
            value={icsEmployeeId}
            onChange={(e) => setIcsEmployeeId(e.target.value)}
            aria-label="Pro koho stáhnout kalendář"
          >
            <option value="all">Všichni</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary-btn"
            onClick={handleExportIcs}
            disabled={assignments.length === 0}
          >
            Stáhnout kalendář
          </button>
        </span>
      </div>

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
