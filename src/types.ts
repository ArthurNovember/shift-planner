export type EmployeeType = 'fulltime' | 'parttime';

export interface Employee {
  id: string;
  name: string;
  type: EmployeeType;
  /** Manually picked color override; falls back to the deterministic palette when unset. */
  color?: string;
}

export type ShiftKind = 'morning' | 'afternoon' | 'weekend';

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
}

export interface Assignment {
  date: string; // ISO yyyy-mm-dd
  employeeId: string;
  shift: ShiftDefinition;
}

export type WarningType =
  | 'pt-hours-exceeded'
  | 'ft-hours-deviation'
  | 'weekend-uneven'
  | 'coverage-gap'
  | 'availability-conflict';

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

/** Target and soft cap for part-time monthly hours: the generator fills shifts up to this total. */
export const PARTTIME_MONTHLY_CAP = 80;

/** Target monthly hours for a fulltime employee - the generator works backwards from this
 * to decide how many days a week they need, so the total lands close to it every month
 * regardless of how many weekdays/weekends that particular month happens to have. */
export const FULLTIME_TARGET_HOURS = 160;

/** How far over the fulltime target actual monthly hours may go before it's flagged - the
 * generator only balances to the day (8.5h chunks), so up to about half a day either way is
 * normal rounding, not a problem. Anything past this is a genuine anomaly (a forced second
 * weekend in a 5-Saturday month, heavy unavailability, etc.) worth surfacing, same as part-time's
 * cap warning. */
export const FULLTIME_HOURS_TOLERANCE = 5;

/** A week where the employee covers the weekend (~19h) gets this many fewer weekday shifts,
 * to balance out that extra weekend load and give them a real rest around it. */
export const FT_SHORT_WEEK_REDUCTION = 2;

/** On a day both fulltime employees are scheduled, this is the chance they both take the
 * same shift (instead of always splitting morning/afternoon) - the other shift becomes a
 * gap for part-time to cover, same as any other short-week gap. */
export const FT_TOGETHER_CHANCE = 0.1;

/** Which weekday shift kind(s) an employee is marked unavailable for on a given date. Weekends
 * have no morning/afternoon split (one shift covers the whole day), so a weekend day off is
 * represented the same way as a full weekday off: both kinds marked. */
export type AvailabilityKind = 'morning' | 'afternoon';

/** employeeId -> ISO date -> set of shift kinds that employee cannot work that day. */
export type UnavailabilityMap = Record<string, Record<string, Set<AvailabilityKind>>>;

export interface ScheduleOptions {
  /** "Long/short week": each week, one part-timer gets a "heavy" role (available Mon/Tue/Fri)
   * and the other a "light" role (available only Wed/Thu), swapping every week for fairness. Since
   * that alone doesn't guarantee equal monthly hours between them, whoever ends up behind has some
   * of their own already-scheduled 4h days upgraded to an 8h SHIFTS.fulltime day to catch up. */
  ptLongShortWeek?: boolean;
}
