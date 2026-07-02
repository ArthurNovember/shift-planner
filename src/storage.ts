import type { Assignment, Employee, UnavailabilityMap } from './types';

const EMPLOYEES_KEY = 'shiftPlanner.employees';
const SCHEDULES_KEY = 'shiftPlanner.schedules';
const UNAVAILABILITY_KEY = 'shiftPlanner.unavailability';

export const DEFAULT_EMPLOYEES: Employee[] = [
  { id: 'ft1', name: 'Zaměstnanec 1', type: 'fulltime' },
  { id: 'ft2', name: 'Zaměstnanec 2', type: 'fulltime' },
  { id: 'pt1', name: 'Zaměstnanec 3', type: 'parttime' },
  { id: 'pt2', name: 'Zaměstnanec 4', type: 'parttime' },
];

export function loadEmployees(): Employee[] {
  try {
    const raw = localStorage.getItem(EMPLOYEES_KEY);
    if (!raw) return DEFAULT_EMPLOYEES;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_EMPLOYEES;
  } catch {
    return DEFAULT_EMPLOYEES;
  }
}

export function saveEmployees(employees: Employee[]): void {
  localStorage.setItem(EMPLOYEES_KEY, JSON.stringify(employees));
}

export type SchedulesMap = Record<string, Assignment[]>;

export function loadSchedules(): SchedulesMap {
  try {
    const raw = localStorage.getItem(SCHEDULES_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveSchedules(schedules: SchedulesMap): void {
  localStorage.setItem(SCHEDULES_KEY, JSON.stringify(schedules));
}

export function monthKey(year: number, month: number): string {
  return `${year}-${month}`;
}

export function loadUnavailability(): UnavailabilityMap {
  try {
    const raw = localStorage.getItem(UNAVAILABILITY_KEY);
    if (!raw) return {};
    const parsed: Record<string, string[]> = JSON.parse(raw);
    const result: UnavailabilityMap = {};
    Object.entries(parsed).forEach(([employeeId, dates]) => {
      result[employeeId] = new Set(dates);
    });
    return result;
  } catch {
    return {};
  }
}

export function saveUnavailability(unavailability: UnavailabilityMap): void {
  const serializable: Record<string, string[]> = {};
  Object.entries(unavailability).forEach(([employeeId, dates]) => {
    serializable[employeeId] = [...dates];
  });
  localStorage.setItem(UNAVAILABILITY_KEY, JSON.stringify(serializable));
}
