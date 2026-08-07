import { useEffect, useMemo, useState } from "react";
import type {
  Assignment,
  AvailabilityKind,
  Employee,
  ShiftDefinition,
  UnavailabilityMap,
  VacationMap,
} from "./types";
import { HOLIDAY_SHIFT, SHIFTS, WEEKEND_SHIFT } from "./types";
import { computeWarnings, generateSchedule, toISODate } from "./scheduler";
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
  loadShowIcsExport,
  loadTheme,
  loadUnavailability,
  loadVacation,
  markHistorySeen,
  monthKey,
  saveDismissedWarnings,
  saveEmployees,
  saveHistory,
  saveSchedules,
  saveShowIcsExport,
  saveTheme,
  saveUnavailability,
  saveVacation,
} from "./storage";
import { supabase } from "./supabaseClient";
import { LoginGate } from "./components/LoginGate";
import { WarningsPanel } from "./components/WarningsPanel";
import { CalendarGrid } from "./components/CalendarGrid";
import { HistoryPanel } from "./components/HistoryPanel";
import { SettingsModal } from "./components/SettingsModal";
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
  const [vacation, setVacation] = useState<VacationMap>({});
  const [dismissedWarnings, setDismissedWarnings] = useState<DismissedWarningsMap>({});
  const [history, setHistory] = useState<HistoryMap>({});
  const [historySeen, setHistorySeen] = useState<HistorySeenMap>(() => loadHistorySeen());
  const [ptLongShortWeek, setPtLongShortWeek] = useState(false);
  const [icsEmployeeId, setIcsEmployeeId] = useState("all");
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [showIcsExport, setShowIcsExport] = useState(() => loadShowIcsExport());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveError, setSaveError] = useState(false);
  const [highlightedDate, setHighlightedDate] = useState<string | null>(null);
  const [preGenerateSnapshot, setPreGenerateSnapshot] = useState<{ key: string; assignments: Assignment[] } | null>(
    null,
  );
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
        const [emp, sched, unavail, vac, dismissed, hist] = await Promise.all([
          loadEmployees(),
          loadSchedules(),
          loadUnavailability(),
          loadVacation(),
          loadDismissedWarnings(),
          loadHistory(),
        ]);
        if (cancelled) return;
        setEmployees(emp);
        setSchedules(sched);
        setUnavailability(unavail);
        setVacation(vac);
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
    saveShowIcsExport(showIcsExport);
  }, [showIcsExport]);
  useEffect(() => {
    if (!loaded) return;
    saveUnavailability(unavailability)
      .then(() => setSaveError(false))
      .catch(() => setSaveError(true));
  }, [unavailability, loaded]);
  useEffect(() => {
    if (!loaded) return;
    saveVacation(vacation)
      .then(() => setSaveError(false))
      .catch(() => setSaveError(true));
  }, [vacation, loaded]);
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
    () => computeWarnings(year, month, employees, assignments, unavailability, vacation),
    [year, month, employees, assignments, unavailability, vacation],
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

  function setAssignments(next: Assignment[]) {
    setSchedules((prev) => ({ ...prev, [key]: next }));
  }

  function handleGenerate() {
    const hadExisting = assignments.length > 0;
    if (hadExisting) {
      const confirmed = window.confirm(
        "Pro tento měsíc už existuje rozvrh. Vygenerovat znovu? Pevně nastavené směny (např. 8!) zůstanou zachované, ostatní ruční úpravy budou přepsány.",
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
        vacation,
        { ptLongShortWeek },
        previousAssignments,
        assignments,
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

  function handleClearSchedule() {
    if (assignments.length === 0) return;
    const confirmed = window.confirm(
      "Opravdu vyprázdnit celý rozvrh pro tento měsíc? Všechny směny budou odebrány.",
    );
    if (!confirmed) return;
    setPreGenerateSnapshot({ key, assignments });
    setAssignments([]);
    appendHistory(key, "Rozvrh byl vyprázdněn.");
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
    const employee = employees.find((e) => e.id === employeeId);
    const currentMarks = unavailability[employeeId]?.[iso] ?? new Set<AvailabilityKind>();
    const becameUnavailable = kind
      ? !currentMarks.has(kind)
      : !(currentMarks.has("morning") && currentMarks.has("afternoon"));
    const kindLabel = kind === "morning" ? "ranní" : kind === "afternoon" ? "odpolední" : "celý den";

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

    if (employee) {
      appendHistory(
        key,
        `${becameUnavailable ? "Nastavena" : "Zrušena"} nedostupnost: ${employee.name}, ${formatHistoryDay(iso)} (${kindLabel}).`,
      );
    }
  }

  // The whole schedule is edited through one move: click a day/employee/shift-kind cell, type
  // an hours number (0 or empty removes it, a trailing "!" locks it as fixed). Start/end time
  // always comes from the standard template for that employee+kind - there's no per-shift custom
  // time editing anymore.
  function handleSetShiftHours(
    date: string,
    employeeId: string,
    kind: ShiftDefinition["kind"],
    hours: number,
    fixed: boolean,
  ) {
    const employee = employees.find((e) => e.id === employeeId);
    if (!employee) return;
    const existingIndex = assignments.findIndex(
      (a) => a.date === date && a.employeeId === employeeId && a.shift.kind === kind,
    );

    if (hours <= 0) {
      if (existingIndex === -1) return;
      setAssignments(assignments.filter((_, i) => i !== existingIndex));
      appendHistory(
        key,
        `Odebrána směna: ${employee.name}, ${formatHistoryDay(date)} (${SHIFT_KIND_LABELS[kind]}).`,
      );
      return;
    }

    const shift = { ...shiftForEmployee(employee, kind), hours, fixed };
    const fixedSuffix = fixed ? " (pevná)" : "";
    if (existingIndex === -1) {
      setAssignments([...assignments, { date, employeeId, shift }]);
      appendHistory(
        key,
        `Přidána směna: ${employee.name}, ${formatHistoryDay(date)} (${SHIFT_KIND_LABELS[kind]}, ${hours} h)${fixedSuffix}.`,
      );
    } else {
      setAssignments(assignments.map((a, i) => (i === existingIndex ? { ...a, shift } : a)));
      appendHistory(
        key,
        `Upravena směna: ${employee.name}, ${formatHistoryDay(date)} (${SHIFT_KIND_LABELS[kind]}) na ${hours} h${fixedSuffix}.`,
      );
    }
  }

  // Vacation is entered as a negative number in the same cell shift hours go in (see
  // CalendarGrid/parseHoursInput) - 0 or a non-negative value clears it, since that means the
  // user typed a real shift hours value or an empty cell there instead. `kind` is which cell
  // (morning/afternoon) it was typed into, so the table only ever shows the entry on that one
  // cell instead of both - the day is still fully blocked from scheduling either way.
  function handleSetVacation(date: string, employeeId: string, hours: number, kind: "morning" | "afternoon") {
    const employee = employees.find((e) => e.id === employeeId);
    if (!employee) return;
    setVacation((prev) => {
      const employeeDays = { ...(prev[employeeId] ?? {}) };
      if (hours <= 0) delete employeeDays[date];
      else employeeDays[date] = { hours, kind };
      return { ...prev, [employeeId]: employeeDays };
    });
    appendHistory(
      key,
      hours > 0
        ? `Nastavena dovolená: ${employee.name}, ${formatHistoryDay(date)} (${hours} h).`
        : `Zrušena dovolená: ${employee.name}, ${formatHistoryDay(date)}.`,
    );
  }

  function handleWarningClick(date: string) {
    document
      .getElementById(`day-${date}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    setHighlightedDate(date);
    setTimeout(() => setHighlightedDate(null), 2000);
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

      <div className="calendar-panel-wrapper">
        <div className="warnings-overlay">
          <WarningsPanel
            warnings={warnings}
            onWarningClick={handleWarningClick}
            onDismiss={handleDismissWarning}
            dismissedWarnings={dismissedWarningObjects}
            onRestore={handleRestoreWarning}
            monthKey={key}
          />
        </div>
        <CalendarGrid
          year={year}
          month={month}
          employees={employees}
          assignments={assignments}
          unavailability={unavailability}
          vacation={vacation}
          onSetShiftHours={handleSetShiftHours}
          onToggleUnavailable={handleToggleUnavailable}
          onSetVacation={handleSetVacation}
          highlightedDate={highlightedDate}
        />
      </div>

      <div className="export-bar">
        <div className="export-bar-left">
          {preGenerateSnapshot?.key === key && (
            <button
              type="button"
              className="secondary-btn revert-generate-btn"
              onClick={handleRevertGenerate}
            >
              Vrátit předchozí rozvrh
            </button>
          )}
          {assignments.length > 0 && (
            <button
              type="button"
              className="secondary-btn"
              onClick={handleClearSchedule}
            >
              Vyprázdnit rozvrh
            </button>
          )}
        </div>
        <div className="export-bar-right">
          <button
            type="button"
            className="secondary-btn"
            onClick={handleExportPdf}
            disabled={assignments.length === 0}
          >
            Stáhnout PDF
          </button>
          {showIcsExport && (
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
          )}
        </div>
      </div>

      <footer className="app-footer">
        <HistoryPanel entries={monthHistory} hasUnseen={hasUnseenHistory} onOpen={handleOpenHistory} />
        <SettingsModal
          employees={employees}
          onChangeEmployees={setEmployees}
          workingEmployees={workingEmployees}
          theme={theme}
          onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
          showIcsExport={showIcsExport}
          onToggleIcsExport={() => setShowIcsExport((v) => !v)}
          onLogout={() => supabase.auth.signOut()}
        />
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
