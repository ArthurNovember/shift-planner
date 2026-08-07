import { useRef, useState } from 'react';
import type { Assignment, AvailabilityKind, Employee, ShiftDefinition, UnavailabilityMap, VacationMap } from '../types';
import { HOLIDAY_SHIFT, SHIFTS, vacationEntryHours, vacationEntryKind, WEEKEND_SHIFT } from '../types';
import { businessDaysInMonth, daysInMonth, toISODate } from '../scheduler';
import { getClosedDays, getCzechHolidays } from '../holidays';

interface Props {
  year: number;
  month: number;
  employees: Employee[];
  assignments: Assignment[];
  unavailability: UnavailabilityMap;
  vacation: VacationMap;
  onSetShiftHours: (
    date: string,
    employeeId: string,
    kind: ShiftDefinition['kind'],
    hours: number,
    fixed: boolean,
  ) => void;
  onToggleUnavailable: (employeeId: string, iso: string, kind?: AvailabilityKind) => void;
  onSetVacation: (date: string, employeeId: string, hours: number, kind: 'morning' | 'afternoon') => void;
  highlightedDate?: string | null;
}

const WEEKDAY_LABELS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
const SHIFT_LABELS: Record<ShiftDefinition['kind'], string> = {
  morning: 'Ranní',
  afternoon: 'Odpolední',
  weekend: 'Víkendová',
  holiday: 'Svátek',
};
const SUBCOL_LABELS: Record<'morning' | 'afternoon', string> = { morning: 'R', afternoon: 'O' };

interface DayInfo {
  date: Date;
  iso: string;
  dow: number;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
}

function dayInfo(year: number, month: number, day: number, holidays: Map<string, string>): DayInfo {
  const date = new Date(year, month, day);
  const iso = toISODate(date);
  const dow = date.getDay();
  const isWeekend = dow === 0 || dow === 6;
  const holidayName = holidays.get(iso);
  const isHoliday = !isWeekend && !!holidayName;
  return { date, iso, dow, isWeekend, isHoliday, holidayName };
}

/** The shift kind(s) a day's column is split into: a plain weekday has a separate morning and
 * afternoon slot, while weekend/holiday days only ever have one whole-day shift. Monday is the
 * same single-column shape as a weekend/holiday for the same reason - it never has an afternoon
 * shift at all (see the generator), just a morning one, so there's nothing to split into an R/O
 * pair. */
function kindsFor(info: DayInfo): ShiftDefinition['kind'][] {
  if (info.isWeekend) return ['weekend'];
  if (info.isHoliday) return ['holiday'];
  if (info.dow === 1) return ['morning'];
  return ['morning', 'afternoon'];
}

function shiftForKind(employee: Employee, kind: ShiftDefinition['kind']): ShiftDefinition {
  if (kind === 'weekend') return WEEKEND_SHIFT;
  if (kind === 'holiday') return HOLIDAY_SHIFT;
  return SHIFTS[employee.type][kind];
}

function formatHours(hours: number): string {
  return hours.toFixed(1).replace('.', ',');
}

/** "8" / "8,5" edits the shift's hours; a trailing "!" (e.g. "8!") also locks it as fixed - the
 * generator leaves a fixed shift alone on regenerate instead of overwriting it. A *negative*
 * number ("-8") means vacation instead of a worked shift - same cell, just the sign flips its
 * meaning: no shift gets scheduled that day and the typed hours come off the monthly target
 * instead of counting toward it. "!" has no meaning on a vacation entry (nothing to fix in place)
 * and is ignored there. */
function parseHoursInput(raw: string): { hours: number; fixed: boolean; vacationHours: number | null } {
  const trimmed = raw.trim();
  const fixed = trimmed.endsWith('!');
  const numeric = fixed ? trimmed.slice(0, -1).trim() : trimmed;
  const parsed = parseFloat(numeric.replace(',', '.'));
  if (Number.isFinite(parsed) && parsed < 0) {
    return { hours: 0, fixed: false, vacationHours: -parsed };
  }
  const hours = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  return { hours, fixed: fixed && hours > 0, vacationHours: null };
}

/** Whether this employee is marked unavailable for this specific cell - a plain weekday's R/O
 * cell checks just its own kind, while a whole-day cell (weekend/holiday, which has no
 * morning/afternoon split of its own) is only "unavailable" once both marks are set together,
 * same as how the day-off toggle below sets them: there's no third kind to represent "off for a
 * single whole day" in the underlying data. */
function isMarkedUnavailable(
  unavailability: UnavailabilityMap,
  employeeId: string,
  iso: string,
  kind: ShiftDefinition['kind'],
): boolean {
  const marks = unavailability[employeeId]?.[iso];
  if (!marks) return false;
  if (kind === 'morning' || kind === 'afternoon') return marks.has(kind);
  return marks.has('morning') && marks.has('afternoon');
}

interface HourInputProps {
  initialHours: number;
  initialFixed: boolean;
  initialVacationHours: number;
  onCommit: (hours: number, fixed: boolean, vacationHours: number | null) => void;
  onCancel: () => void;
}

/** The whole editing UI for a cell: click a shift, type how many hours (optionally followed by
 * "!" to lock it as fixed, or negative for vacation - see parseHoursInput), done - no separate
 * popover, no time pickers. Committing happens on blur (including a blur triggered by Enter);
 * Escape cancels instead by flagging the blur that follows it to skip the commit. */
function HourInput({ initialHours, initialFixed, initialVacationHours, onCommit, onCancel }: HourInputProps) {
  const [value, setValue] = useState(
    initialVacationHours > 0
      ? `-${formatHours(initialVacationHours)}`
      : initialHours > 0
        ? `${formatHours(initialHours)}${initialFixed ? '!' : ''}`
        : '',
  );
  const cancelledRef = useRef(false);

  function commit() {
    const { hours, fixed, vacationHours } = parseHoursInput(value);
    onCommit(hours, fixed, vacationHours);
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      className="schedule-cell schedule-cell-input"
      value={value}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelledRef.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (cancelledRef.current) {
          onCancel();
          return;
        }
        commit();
      }}
    />
  );
}

export function CalendarGrid({
  year,
  month,
  employees,
  assignments,
  unavailability,
  vacation,
  onSetShiftHours,
  onToggleUnavailable,
  onSetVacation,
  highlightedDate,
}: Props) {
  const totalDays = daysInMonth(year, month);
  const todayIso = toISODate(new Date());
  const holidays = getCzechHolidays(year);
  const days = Array.from({ length: totalDays }, (_, i) => i + 1);
  const dayInfos = days.map((day) => dayInfo(year, month, day, holidays));

  const [editingCell, setEditingCell] = useState<{
    date: string;
    employeeId: string;
    kind: ShiftDefinition['kind'];
  } | null>(null);

  const hoursByCellKind = new Map<string, number>();
  const fixedByCellKind = new Map<string, boolean>();
  assignments.forEach((a) => {
    const k = `${a.date}|${a.employeeId}|${a.shift.kind}`;
    hoursByCellKind.set(k, (hoursByCellKind.get(k) ?? 0) + a.shift.hours);
    if (a.shift.fixed) fixedByCellKind.set(k, true);
  });

  const totalHoursByEmployee = new Map<string, number>();
  assignments.forEach((a) => {
    totalHoursByEmployee.set(a.employeeId, (totalHoursByEmployee.get(a.employeeId) ?? 0) + a.shift.hours);
  });

  // Vacation blocks the whole day (see VacationMap) but is only ever *displayed* on the one cell
  // it was typed into, so it reads as one shift's worth of marker rather than looking like both
  // the morning and afternoon got separately cancelled.
  const vacationByDay = new Map<string, { hours: number; kind: 'morning' | 'afternoon' }>();
  Object.entries(vacation).forEach(([employeeId, days]) => {
    Object.entries(days).forEach(([iso, entry]) => {
      vacationByDay.set(`${iso}|${employeeId}`, entry);
    });
  });

  // This month's own target/cap - the same "fond pracovní doby" business-day count the generator
  // itself targets (see businessDaysInMonth in scheduler.ts), minus whatever vacation this
  // employee logged this month. Doesn't include the generator's own small cross-month nudge
  // (±8h, based on how close last month landed to its own target) - that's a minor refinement on
  // top of this, not the headline number someone glancing at the table needs; genuine deviations
  // from it still surface via the warnings panel.
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  function vacationHoursThisMonth(employeeId: string): number {
    const days = vacation[employeeId];
    if (!days) return 0;
    return Object.entries(days).reduce((sum, [iso, entry]) => (iso.startsWith(monthPrefix) ? sum + vacationEntryHours(entry) : sum), 0);
  }
  const monthlyFulltimeTargetHours = businessDaysInMonth(year, month, holidays, getClosedDays(year)) * SHIFTS.fulltime.morning.hours;
  const monthlyParttimeCapHours = monthlyFulltimeTargetHours / 2;
  function limitForEmployee(employee: Employee): number {
    const base = employee.type === 'fulltime' ? monthlyFulltimeTargetHours : monthlyParttimeCapHours;
    return Math.max(0, base - vacationHoursThisMonth(employee.id));
  }

  return (
    <section className="panel calendar-panel">
      <h2>Rozvrh</h2>
      <p className="muted">
        Klikněte na políčko a napište počet odpracovaných hodin (0 nebo prázdné pole směnu odebere). Číslo s
        vykřičníkem (např. 8!) směnu zafixuje - při přegenerování rozvrhu ji generátor nepřepíše. Záporné číslo
        (např. -8) označí dovolenou - ten den se nenaplánuje a hodiny se odečtou z měsíčního cíle. Pravým tlačítkem
        označte, kdy daný člověk nemůže pracovat - generátor to bude respektovat.
      </p>
      <div className="schedule-scroll">
        <table className="schedule-table">
          <thead>
            <tr>
              <th className="schedule-corner" rowSpan={2} />
              {dayInfos.map((info) => {
                const split = kindsFor(info).length > 1;
                const isToday = info.iso === todayIso;
                const isHighlighted = info.iso === highlightedDate;
                return (
                  <th
                    key={info.iso}
                    id={`day-${info.iso}`}
                    colSpan={split ? 2 : 1}
                    rowSpan={split ? 1 : 2}
                    className={`schedule-day-header${info.isWeekend ? ' weekend' : ''}${info.isHoliday ? ' holiday' : ''}${isToday ? ' today' : ''}${isHighlighted ? ' highlighted' : ''}`}
                    title={info.holidayName}
                  >
                    <span className="schedule-day-weekday">{WEEKDAY_LABELS[(info.dow + 6) % 7]}</span>
                    <span className="schedule-day-number">{info.date.getDate()}</span>
                  </th>
                );
              })}
              <th className="schedule-total-header" rowSpan={2}>
                Celkem / limit
              </th>
            </tr>
            <tr>
              {dayInfos.flatMap((info) => {
                const kinds = kindsFor(info);
                if (kinds.length === 1) return [];
                const isToday = info.iso === todayIso;
                const isHighlighted = info.iso === highlightedDate;
                return (kinds as ('morning' | 'afternoon')[]).map((kind, kindIdx) => (
                  <th
                    key={`${info.iso}-${kind}`}
                    className={`schedule-subheader${kindIdx === 0 ? ' day-start' : ''}${isToday ? ' today' : ''}${isHighlighted ? ' highlighted' : ''}`}
                    title={SHIFT_LABELS[kind]}
                  >
                    {SUBCOL_LABELS[kind]}
                  </th>
                ));
              })}
            </tr>
          </thead>
          <tbody>
            {employees.map((emp) => (
              <tr key={emp.id}>
                <th className="schedule-employee-name">{emp.name}</th>
                {dayInfos.flatMap((info) => {
                  const isToday = info.iso === todayIso;
                  const isHighlighted = info.iso === highlightedDate;
                  return kindsFor(info).map((kind, kindIdx) => {
                    const cellKey = `${info.iso}|${emp.id}|${kind}`;
                    const hours = hoursByCellKind.get(cellKey) ?? 0;
                    const isFixed = fixedByCellKind.get(cellKey) ?? false;
                    const unavailable = isMarkedUnavailable(unavailability, emp.id, info.iso, kind);
                    // Vacation only applies to a normal weekday's R/O cells - a whole-day
                    // weekend/holiday shift isn't the kind of thing a single day of vacation
                    // substitutes for, so those cells never show or accept it. Only the specific
                    // cell it was typed into shows it, even though the day is blocked either way -
                    // see VacationMap.
                    const canHaveVacation = kind === 'morning' || kind === 'afternoon';
                    const vacationEntry = canHaveVacation ? vacationByDay.get(`${info.iso}|${emp.id}`) : undefined;
                    const vacationHours =
                      vacationEntry && vacationEntryKind(vacationEntry) === kind ? vacationEntryHours(vacationEntry) : 0;
                    const isEditing =
                      editingCell?.date === info.iso &&
                      editingCell?.employeeId === emp.id &&
                      editingCell?.kind === kind;
                    return (
                      <td
                        key={`${info.iso}-${kind}`}
                        className={`${kindIdx === 0 ? 'day-start' : ''}${info.isWeekend ? ' weekend' : ''}${info.isHoliday ? ' holiday' : ''}${isToday ? ' today' : ''}${isHighlighted ? ' highlighted' : ''}`}
                      >
                        {isEditing ? (
                          <HourInput
                            initialHours={hours > 0 ? hours : shiftForKind(emp, kind).hours}
                            initialFixed={isFixed}
                            initialVacationHours={vacationHours}
                            onCommit={(value, fixed, newVacationHours) => {
                              // Vacation only makes sense for a normal weekday's own R/O cell -
                              // weekend/holiday cells fall through to the ordinary hours path even
                              // for a typed negative number, same as an invalid number would.
                              if (newVacationHours !== null && (kind === 'morning' || kind === 'afternoon')) {
                                onSetVacation(info.iso, emp.id, newVacationHours, kind);
                                if (hours > 0) onSetShiftHours(info.iso, emp.id, kind, 0, false);
                              } else {
                                onSetShiftHours(info.iso, emp.id, kind, value, fixed);
                                if (vacationHours > 0 && (kind === 'morning' || kind === 'afternoon')) {
                                  onSetVacation(info.iso, emp.id, 0, kind);
                                }
                              }
                              setEditingCell(null);
                            }}
                            onCancel={() => setEditingCell(null)}
                          />
                        ) : (
                          <button
                            type="button"
                            className={`schedule-cell${hours > 0 ? ' filled' : ''}${(kind === 'afternoon' || kind === 'weekend') && hours > 0 ? ' emphasize' : ''}${unavailable ? ' unavailable' : ''}${isFixed ? ' fixed' : ''}${vacationHours > 0 ? ' vacation' : ''}`}
                            title={`${emp.name}, ${info.date.getDate()}. ${month + 1}. – ${SHIFT_LABELS[kind]}${
                              vacationHours > 0
                                ? ` – dovolená, ${vacationHours.toFixed(1)} h`
                                : hours > 0
                                  ? ` – ${hours.toFixed(1)} h`
                                  : ''
                            }${isFixed ? ' (pevná směna)' : ''}${unavailable ? ' – nedostupný (pravé tlačítko zruší)' : ' – pravé tlačítko označí jako nedostupný'}`}
                            onClick={() => setEditingCell({ date: info.iso, employeeId: emp.id, kind })}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              onToggleUnavailable(
                                emp.id,
                                info.iso,
                                kind === 'morning' || kind === 'afternoon' ? kind : undefined,
                              );
                            }}
                          >
                            {vacationHours > 0
                              ? `-${formatHours(vacationHours)}`
                              : hours > 0
                                ? `${formatHours(hours)}${isFixed ? '!' : ''}`
                                : ''}
                          </button>
                        )}
                      </td>
                    );
                  });
                })}
                <td className="schedule-total-cell">
                  <span className="schedule-total-value">{formatHours(totalHoursByEmployee.get(emp.id) ?? 0)} h</span>
                  <span className="schedule-limit-value"> / {formatHours(limitForEmployee(emp))} h</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
