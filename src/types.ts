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
  | 'pt-hours-near-limit'
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

/** A week where the employee covers the weekend (~19h) gets this many fewer weekday shifts,
 * to balance out that extra weekend load and give them a real rest around it. */
export const FT_SHORT_WEEK_REDUCTION = 2;

/** employeeId -> set of ISO dates that employee cannot work. */
export type UnavailabilityMap = Record<string, Set<string>>;
