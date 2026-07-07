import type { Assignment, Employee, UnavailabilityMap } from './types';
import { supabase } from './supabaseClient';

const EMPLOYEES_KEY = 'shiftPlanner.employees';
const SCHEDULES_KEY = 'shiftPlanner.schedules';
const UNAVAILABILITY_KEY = 'shiftPlanner.unavailability';
const THEME_KEY = 'shiftPlanner.theme';
const HISTORY_SEEN_KEY = 'shiftPlanner.historySeen';

export type Theme = 'dark' | 'light';

// Theme is a per-device display preference, not shared team data - stays in localStorage.
export function loadTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
}

export const DEFAULT_EMPLOYEES: Employee[] = [
  { id: 'ft1', name: 'Zaměstnanec 1', type: 'fulltime' },
  { id: 'ft2', name: 'Zaměstnanec 2', type: 'fulltime' },
  { id: 'pt1', name: 'Zaměstnanec 3', type: 'parttime' },
  { id: 'pt2', name: 'Zaměstnanec 4', type: 'parttime' },
];

export type SchedulesMap = Record<string, Assignment[]>;

// monthKey -> list of warning messages the user has dismissed as "known, fine as is" (e.g. a
// coverage gap because someone's doing inventory that day) - dismissal is by message text since
// that's the only thing that actually identifies one specific warning instance today.
export type DismissedWarningsMap = Record<string, string[]>;

export interface HistoryEntry {
  timestamp: string; // ISO
  message: string;
}

// monthKey -> edit-history entries for that month's schedule, oldest first.
export type HistoryMap = Record<string, HistoryEntry[]>;

// monthKey -> ISO timestamp of the newest history entry this browser has seen. This is
// deliberately per-device localStorage, not cloud state - it's what lets each employee's
// browser independently know whether *it* has seen the latest edits, same idea as THEME_KEY.
export type HistorySeenMap = Record<string, string>;

export function loadHistorySeen(): HistorySeenMap {
  try {
    const raw = localStorage.getItem(HISTORY_SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function markHistorySeen(monthKey: string, timestamp: string): HistorySeenMap {
  const next = { ...loadHistorySeen(), [monthKey]: timestamp };
  localStorage.setItem(HISTORY_SEEN_KEY, JSON.stringify(next));
  return next;
}

type SerializedUnavailability = Record<string, Record<string, ('morning' | 'afternoon')[]>>;

function deserializeUnavailability(parsed: SerializedUnavailability): UnavailabilityMap {
  const result: UnavailabilityMap = {};
  Object.entries(parsed).forEach(([employeeId, days]) => {
    const employeeDays: Record<string, Set<'morning' | 'afternoon'>> = {};
    Object.entries(days).forEach(([iso, kinds]) => {
      employeeDays[iso] = new Set(kinds);
    });
    result[employeeId] = employeeDays;
  });
  return result;
}

function serializeUnavailability(unavailability: UnavailabilityMap): SerializedUnavailability {
  const serializable: SerializedUnavailability = {};
  Object.entries(unavailability).forEach(([employeeId, days]) => {
    const employeeDays: Record<string, ('morning' | 'afternoon')[]> = {};
    Object.entries(days).forEach(([iso, kinds]) => {
      employeeDays[iso] = [...kinds];
    });
    serializable[employeeId] = employeeDays;
  });
  return serializable;
}

// --- Cloud (Supabase) persistence: shared across every computer, gated by RLS to signed-in
//     users only. Each table is a single row (id=1) holding one JSON blob, mirroring the shape
//     these used to have in localStorage - keeps scheduler.ts and every component untouched. ---

export async function loadEmployees(): Promise<Employee[]> {
  const { data, error } = await supabase.from('employees_state').select('data').eq('id', 1).maybeSingle();
  if (error) throw error;
  const employees = data?.data as Employee[] | undefined;
  return employees && employees.length > 0 ? employees : DEFAULT_EMPLOYEES;
}

export async function saveEmployees(employees: Employee[]): Promise<void> {
  const { error } = await supabase
    .from('employees_state')
    .upsert({ id: 1, data: employees, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function loadSchedules(): Promise<SchedulesMap> {
  const { data, error } = await supabase.from('schedules_state').select('data').eq('id', 1).maybeSingle();
  if (error) throw error;
  return (data?.data as SchedulesMap | undefined) ?? {};
}

export async function saveSchedules(schedules: SchedulesMap): Promise<void> {
  const { error } = await supabase
    .from('schedules_state')
    .upsert({ id: 1, data: schedules, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function loadUnavailability(): Promise<UnavailabilityMap> {
  const { data, error } = await supabase.from('unavailability_state').select('data').eq('id', 1).maybeSingle();
  if (error) throw error;
  return deserializeUnavailability((data?.data as SerializedUnavailability | undefined) ?? {});
}

export async function saveUnavailability(unavailability: UnavailabilityMap): Promise<void> {
  const { error } = await supabase
    .from('unavailability_state')
    .upsert({ id: 1, data: serializeUnavailability(unavailability), updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function loadDismissedWarnings(): Promise<DismissedWarningsMap> {
  const { data, error } = await supabase.from('dismissed_warnings_state').select('data').eq('id', 1).maybeSingle();
  if (error) throw error;
  return (data?.data as DismissedWarningsMap | undefined) ?? {};
}

export async function saveDismissedWarnings(dismissedWarnings: DismissedWarningsMap): Promise<void> {
  const { error } = await supabase
    .from('dismissed_warnings_state')
    .upsert({ id: 1, data: dismissedWarnings, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function loadHistory(): Promise<HistoryMap> {
  const { data, error } = await supabase.from('schedule_history_state').select('data').eq('id', 1).maybeSingle();
  if (error) throw error;
  return (data?.data as HistoryMap | undefined) ?? {};
}

export async function saveHistory(history: HistoryMap): Promise<void> {
  const { error } = await supabase
    .from('schedule_history_state')
    .upsert({ id: 1, data: history, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export function monthKey(year: number, month: number): string {
  return `${year}-${month}`;
}

// --- One-time migration: the app used to keep everything in this browser's localStorage.
//     On first login, if the cloud is still empty but this browser has real (non-default) data
//     from before the switch, offer to upload it instead of silently starting from scratch. ---

export interface LocalSnapshot {
  employees: Employee[];
  schedules: SchedulesMap;
  unavailability: UnavailabilityMap;
}

export function hasLocalData(): boolean {
  return (
    localStorage.getItem(EMPLOYEES_KEY) !== null ||
    localStorage.getItem(SCHEDULES_KEY) !== null ||
    localStorage.getItem(UNAVAILABILITY_KEY) !== null
  );
}

export function loadLocalSnapshot(): LocalSnapshot {
  let employees: Employee[] = DEFAULT_EMPLOYEES;
  try {
    const raw = localStorage.getItem(EMPLOYEES_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length > 0) employees = parsed;
  } catch {
    // ignore malformed local data
  }

  let schedules: SchedulesMap = {};
  try {
    const raw = localStorage.getItem(SCHEDULES_KEY);
    if (raw) schedules = JSON.parse(raw);
  } catch {
    // ignore malformed local data
  }

  let unavailability: UnavailabilityMap = {};
  try {
    const raw = localStorage.getItem(UNAVAILABILITY_KEY);
    if (raw) unavailability = deserializeUnavailability(JSON.parse(raw));
  } catch {
    // ignore malformed local data
  }

  return { employees, schedules, unavailability };
}

export async function hasCloudData(): Promise<boolean> {
  const { data, error } = await supabase.from('employees_state').select('id').eq('id', 1).maybeSingle();
  if (error) throw error;
  return data !== null;
}
