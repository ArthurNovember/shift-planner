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

export const PARTTIME_MONTHLY_CAP = 80;

/**
 * A week where an employee covers the weekend (~19h) is a "short week" with fewer
 * weekday shifts, to balance out their total hours against a normal "long week".
 */
export const FT_LONG_WEEK_DAYS = 5;
export const FT_SHORT_WEEK_DAYS = 3;
export const PT_LONG_WEEK_SHIFTS = 3;
export const PT_SHORT_WEEK_SHIFTS = 1;
