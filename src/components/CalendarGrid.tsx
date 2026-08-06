import { useRef, useState } from 'react';
import type { Assignment, AvailabilityKind, Employee, ShiftDefinition, UnavailabilityMap } from '../types';
import { HOLIDAY_SHIFT, SHIFTS, WEEKEND_SHIFT } from '../types';
import { daysInMonth, toISODate } from '../scheduler';
import { getCzechHolidays } from '../holidays';

interface Props {
  year: number;
  month: number;
  employees: Employee[];
  assignments: Assignment[];
  unavailability: UnavailabilityMap;
  onSetShiftHours: (
    date: string,
    employeeId: string,
    kind: ShiftDefinition['kind'],
    hours: number,
    fixed: boolean,
  ) => void;
  onToggleUnavailable: (employeeId: string, iso: string, kind?: AvailabilityKind) => void;
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
 * generator leaves a fixed shift alone on regenerate instead of overwriting it. */
function parseHoursInput(raw: string): { hours: number; fixed: boolean } {
  const trimmed = raw.trim();
  const fixed = trimmed.endsWith('!');
  const numeric = fixed ? trimmed.slice(0, -1).trim() : trimmed;
  const parsed = parseFloat(numeric.replace(',', '.'));
  const hours = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  return { hours, fixed: fixed && hours > 0 };
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
  onCommit: (hours: number, fixed: boolean) => void;
  onCancel: () => void;
}

/** The whole editing UI for a cell: click a shift, type how many hours (optionally followed by
 * "!" to lock it as fixed), done - no separate popover, no time pickers. Committing happens on
 * blur (including a blur triggered by Enter); Escape cancels instead by flagging the blur that
 * follows it to skip the commit. */
function HourInput({ initialHours, initialFixed, onCommit, onCancel }: HourInputProps) {
  const [value, setValue] = useState(
    initialHours > 0 ? `${formatHours(initialHours)}${initialFixed ? '!' : ''}` : '',
  );
  const cancelledRef = useRef(false);

  function commit() {
    const { hours, fixed } = parseHoursInput(value);
    onCommit(hours, fixed);
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
  onSetShiftHours,
  onToggleUnavailable,
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

  return (
    <section className="panel calendar-panel">
      <h2>Rozvrh</h2>
      <p className="muted">
        Klikněte na políčko a napište počet odpracovaných hodin (0 nebo prázdné pole směnu odebere). Číslo s
        vykřičníkem (např. 8!) směnu zafixuje - při přegenerování rozvrhu ji generátor nepřepíše. Pravým tlačítkem
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
                Celkem
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
                            onCommit={(value, fixed) => {
                              onSetShiftHours(info.iso, emp.id, kind, value, fixed);
                              setEditingCell(null);
                            }}
                            onCancel={() => setEditingCell(null)}
                          />
                        ) : (
                          <button
                            type="button"
                            className={`schedule-cell${hours > 0 ? ' filled' : ''}${(kind === 'afternoon' || kind === 'weekend') && hours > 0 ? ' emphasize' : ''}${unavailable ? ' unavailable' : ''}${isFixed ? ' fixed' : ''}`}
                            title={`${emp.name}, ${info.date.getDate()}. ${month + 1}. – ${SHIFT_LABELS[kind]}${hours > 0 ? ` – ${hours.toFixed(1)} h` : ''}${isFixed ? ' (pevná směna)' : ''}${unavailable ? ' – nedostupný (pravé tlačítko zruší)' : ' – pravé tlačítko označí jako nedostupný'}`}
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
                            {hours > 0 ? `${formatHours(hours)}${isFixed ? '!' : ''}` : ''}
                          </button>
                        )}
                      </td>
                    );
                  });
                })}
                <td className="schedule-total-cell">
                  <span className="schedule-total-value">{formatHours(totalHoursByEmployee.get(emp.id) ?? 0)} h</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
