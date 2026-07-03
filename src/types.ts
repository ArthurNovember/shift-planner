export type EmployeeType = 'fulltime' | 'parttime';

export interface Employee {
  id: string;
  name: string;
  type: EmployeeType;
}

export type ShiftKind = 'morning' | 'afternoon' | 'weekend';

export interface ShiftDefinition {
  kind: ShiftKind;
  start: string;
  end: string;
  hours: number;
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
  | 'coverage-gap';

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

export const SHIFTS: Record<'fulltime' | 'parttime', { morning: ShiftDefinition; afternoon: ShiftDefinition }> = {
  fulltime: {
    morning: { kind: 'morning', start: '08:00', end: '16:30', hours: 8.5 },
    afternoon: { kind: 'afternoon', start: '11:30', end: '20:00', hours: 8.5 },
  },
  parttime: {
    morning: { kind: 'morning', start: '09:00', end: '13:00', hours: 4 },
    afternoon: { kind: 'afternoon', start: '16:00', end: '20:00', hours: 4 },
  },
};

export const WEEKEND_SHIFT: ShiftDefinition = { kind: 'weekend', start: '10:15', end: '19:45', hours: 9.5 };

/** Target and soft cap for part-time monthly hours: the generator fills shifts up to this total. */
export const PARTTIME_MONTHLY_CAP = 80;

/** Target monthly hours for a fulltime employee - the generator works backwards from this
 * to decide how many days a week they need, so the total lands close to it every month
 * regardless of how many weekdays/weekends that particular month happens to have. */
export const FULLTIME_TARGET_HOURS = 160;

/** How far a fulltime employee's actual monthly hours may drift from the target before it's
 * flagged - the generator only balances to the day (8.5h chunks) and occasionally has to give
 * someone a second weekend in a month with 5 Saturdays, so some drift is normal; this catches
 * genuinely large deviations without flagging every ordinary month. */
export const FULLTIME_HOURS_TOLERANCE = 15;

/** A week where the employee covers the weekend (~19h) gets this many fewer weekday shifts,
 * to balance out that extra weekend load and give them a real rest around it. */
export const FT_SHORT_WEEK_REDUCTION = 2;

/** On a day both fulltime employees are scheduled, this is the chance they both take the
 * same shift (instead of always splitting morning/afternoon) - the other shift becomes a
 * gap for part-time to cover, same as any other short-week gap. */
export const FT_TOGETHER_CHANCE = 0.1;

/** In part-time "regularity mode", how many fixed morning shifts a normal week gets. Kept
 * deliberately light (not hunting for the 80h cap) so the pattern stays genuinely regular. */
export const PT_REGULAR_LONG_WEEK_SHIFTS = 3;

/** In part-time "regularity mode", a week where the employee covers the weekend gets this
 * many fewer morning shifts, so they rest around it like fulltime does. */
export const PT_SHORT_WEEK_REDUCTION = 2;

/** employeeId -> set of ISO dates that employee cannot work. */
export type UnavailabilityMap = Record<string, Set<string>>;

export interface ScheduleOptions {
  /** Give each part-timer a fixed recurring weekly morning pattern instead of the default
   * greedy hour-filling, so their shifts land on the same weekdays every week. */
  ptRegularityMode?: boolean;
}
