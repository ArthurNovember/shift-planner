export type EmployeeType = 'fulltime' | 'parttime';

export interface Employee {
  id: string;
  name: string;
  type: EmployeeType;
  /** Manually picked color override; falls back to the deterministic palette when unset. */
  color?: string;
}

export type ShiftKind = 'morning' | 'afternoon' | 'weekend' | 'holiday';

export interface ShiftDefinition {
  kind: ShiftKind;
  start: string;
  end: string;
  /** Hours counted toward totals/limits - the time span minus any lunch break (see
   * breakMinutes), not the raw clock duration. */
  hours: number;
  /** Minutes deducted from the clock span to get `hours` - legally applies whenever a shift
   * exceeds 6h, regardless of employment type. 0/undefined means no break is currently applied
   * (either the shift is 6h or under, or it's over 6h but the break was manually removed/never
   * added - see the "+ oběd"/"− oběd" toggle in CalendarGrid). */
  breakMinutes?: number;
  /** Manually locked in before generating (typed as e.g. "8!" in the schedule table) - the
   * generator treats it as already spoken for and builds the rest of the month around it instead
   * of overwriting it on regenerate. */
  fixed?: boolean;
}

export interface Assignment {
  date: string; // ISO yyyy-mm-dd
  employeeId: string;
  shift: ShiftDefinition;
}

export type WarningType =
  | 'pt-hours-exceeded'
  | 'ft-hours-deviation'
  | 'coverage-gap'
  | 'availability-conflict'
  | 'holiday-shift';

export interface ScheduleWarning {
  type: WarningType;
  message: string;
  employeeId?: string;
  date?: string;
}

export interface MonthSchedule {
  year: number;
  month: number; // 0-11
  assignments: Assignment[];
}

// Fulltime shifts are 8.5h clock spans, but 30 minutes of that is the legally required lunch
// break for any shift over 6h - it doesn't count as worked time, so `hours` is 8, not 8.5.
export const SHIFTS: Record<'fulltime' | 'parttime', { morning: ShiftDefinition; afternoon: ShiftDefinition }> = {
  fulltime: {
    morning: { kind: 'morning', start: '08:00', end: '16:30', hours: 8, breakMinutes: 30 },
    afternoon: { kind: 'afternoon', start: '11:30', end: '20:00', hours: 8, breakMinutes: 30 },
  },
  parttime: {
    morning: { kind: 'morning', start: '09:00', end: '13:00', hours: 4 },
    afternoon: { kind: 'afternoon', start: '16:00', end: '20:00', hours: 4 },
  },
};

// The weekend shift is a 9.5h span for whoever covers it, full or part time - also over 6h, so
// the same break applies.
export const WEEKEND_SHIFT: ShiftDefinition = { kind: 'weekend', start: '10:15', end: '19:45', hours: 9, breakMinutes: 30 };

// On a public holiday the team runs a skeleton crew - one person for the whole day - instead of
// the usual full morning+afternoon coverage.
export const HOLIDAY_SHIFT: ShiftDefinition = { kind: 'holiday', start: '09:00', end: '17:30', hours: 8, breakMinutes: 30 };

/** How far over the fulltime target actual monthly hours may go before it's flagged - the
 * generator only balances to the day (8.5h chunks), so up to about half a day either way is
 * normal rounding, not a problem. Anything past this is a genuine anomaly (a forced second
 * weekend in a 5-Saturday month, heavy unavailability, etc.) worth surfacing, same as part-time's
 * cap warning. */
export const FULLTIME_HOURS_TOLERANCE = 5;

/** A week where the employee covers the weekend (~19h) gets this many fewer weekday shifts, to
 * give them a real rest before it. Paired with FT_POST_WEEKEND_RECOVERY_DAYS for a break on both
 * sides of the weekend; kept at 1 (not 2) so the two together total 2 days, matching what a single
 * ~19h weekend actually displaces (about 2.25 weekdays) rather than overshooting it and running
 * every weekend-covering month a day short of the monthly target. */
export const FT_SHORT_WEEK_REDUCTION = 1;

/** The week right after covering the weekend gets this many fewer weekday shifts too, trimmed
 * from its very start (Monday) - since the weekend person now works straight through Friday into
 * the weekend (see the Friday-afternoon preference), this is the only place left for a real break
 * to land before the following week's shifts would otherwise run right on into it. */
export const FT_POST_WEEKEND_RECOVERY_DAYS = 1;

/** On a day both fulltime employees are scheduled, this is the chance they both take the
 * same shift (instead of always splitting morning/afternoon) - the other shift becomes a
 * gap for part-time to cover, same as any other short-week gap. */
export const FT_TOGETHER_CHANCE = 0.1;

/** Soft target for how many calendar days in a row (any shift kind) someone should work at
 * most - a schedule that's otherwise fine but runs someone 8-10 days straight isn't a good
 * schedule. Lower priority than every other rule: the generator only tries to fix a longer
 * streak by handing one day to a same-type coworker when that's possible without breaking
 * anything else, and simply leaves it alone otherwise. */
export const MAX_CONSECUTIVE_SHIFTS = 6;

/** Which weekday shift kind(s) an employee is marked unavailable for on a given date. Weekends
 * have no morning/afternoon split (one shift covers the whole day), so a weekend day off is
 * represented the same way as a full weekday off: both kinds marked. */
export type AvailabilityKind = 'morning' | 'afternoon';

/** employeeId -> ISO date -> set of shift kinds that employee cannot work that day. */
export type UnavailabilityMap = Record<string, Record<string, Set<AvailabilityKind>>>;

/** employeeId -> ISO date -> vacation hours logged that day, and which cell (morning/afternoon)
 * it was typed into - typed as a negative number (e.g. "-8") straight into the same schedule cell
 * that would otherwise hold worked hours, there's no separate "vacation mode", just the sign of
 * what gets typed. `kind` only decides which single cell displays the entry (a whole vacation day
 * shown on both would look like two separate shifts) - the scheduling effect itself still blocks
 * the entire day (there's no "half a day of vacation" concept, unlike morning/afternoon
 * unavailability) and reduces that employee's effective monthly target/cap by the logged amount,
 * rather than the generator/warnings treating the missing hours as an unexplained shortfall. */
export type VacationMap = Record<string, Record<string, { hours: number; kind: 'morning' | 'afternoon' }>>;

/** Reads the hours back out of a VacationMap entry defensively - `vacation` round-trips through
 * Supabase as plain JSON, an external-storage boundary that could still hold a bare-number entry
 * from before `kind` was tracked (an earlier shape of this same type), so this tolerates that
 * shape too instead of every reader silently producing NaN on it forever after. */
export function vacationEntryHours(entry: unknown): number {
  if (typeof entry === 'number') return Number.isFinite(entry) ? entry : 0;
  const hours = (entry as { hours?: unknown } | undefined)?.hours;
  return typeof hours === 'number' && Number.isFinite(hours) ? hours : 0;
}

/** Which cell a VacationMap entry displays on - defaults to "morning" for a legacy bare-number
 * entry (or anything else without a recognizable kind) that predates `kind` being tracked at all,
 * so it still shows up *somewhere* and can be seen and cleared through the table instead of
 * silently blocking a day with nothing in the UI to click. */
export function vacationEntryKind(entry: unknown): 'morning' | 'afternoon' {
  const kind = (entry as { kind?: unknown } | undefined)?.kind;
  return kind === 'afternoon' ? 'afternoon' : 'morning';
}

export interface ScheduleOptions {
  /** "Long/short week": each week, one part-timer gets a "heavy" role (available Mon/Tue/Fri)
   * and the other a "light" role (available only Wed/Thu), swapping every week for fairness. Since
   * that alone doesn't guarantee equal monthly hours between them, whoever ends up behind has some
   * of their own already-scheduled 4h days upgraded to an 8h SHIFTS.fulltime day to catch up. */
  ptLongShortWeek?: boolean;
}
