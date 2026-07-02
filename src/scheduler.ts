import type { Assignment, Employee, ScheduleWarning, ShiftDefinition } from './types';
import {
  FT_LONG_WEEK_DAYS,
  FT_SHORT_WEEK_DAYS,
  PARTTIME_MONTHLY_CAP,
  PT_LONG_WEEK_SHIFTS,
  PT_SHORT_WEEK_SHIFTS,
  SHIFTS,
  WEEKEND_SHIFT,
} from './types';

/** Which shift definitions make sense for this employee on a weekday vs. weekend day. */
export function shiftOptionsFor(employee: Employee, isWeekend: boolean): ShiftDefinition[] {
  if (isWeekend) return [WEEKEND_SHIFT];
  return [SHIFTS[employee.type].morning, SHIFTS[employee.type].afternoon];
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function mondayOf(d: Date): Date {
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(d);
  monday.setDate(d.getDate() - dow);
  return monday;
}

/** Generates a full month's assignments from scratch, following the team's shift rules. */
export function generateSchedule(year: number, month: number, employees: Employee[]): Assignment[] {
  const assignments: Assignment[] = [];
  const fulltime = employees.filter((e) => e.type === 'fulltime');
  const parttime = employees.filter((e) => e.type === 'parttime');
  const totalDays = daysInMonth(year, month);
  const monthIndex = year * 12 + month;

  // --- Weekends: one employee covers both Saturday and Sunday with the weekend shift ---
  const weekendPairs: { saturday: Date; sunday: Date }[] = [];
  for (let day = 1; day <= totalDays; day++) {
    const d = new Date(year, month, day);
    if (d.getDay() === 6) {
      weekendPairs.push({ saturday: d, sunday: new Date(year, month, day + 1) });
    }
  }

  const weekendEmployeeByWeekKey = new Map<string, string>();
  if (employees.length > 0) {
    const weekendStart = monthIndex % employees.length;
    weekendPairs.forEach((pair, idx) => {
      const emp = employees[(weekendStart + idx) % employees.length];
      assignments.push({ date: toISODate(pair.saturday), employeeId: emp.id, shift: WEEKEND_SHIFT });
      assignments.push({ date: toISODate(pair.sunday), employeeId: emp.id, shift: WEEKEND_SHIFT });
      weekendEmployeeByWeekKey.set(toISODate(mondayOf(pair.saturday)), emp.id);
    });
  }

  // --- Group this month's weekdays by the Monday that starts their calendar week ---
  const weekdaysByWeekKey = new Map<string, Date[]>();
  for (let day = 1; day <= totalDays; day++) {
    const d = new Date(year, month, day);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const weekKey = toISODate(mondayOf(d));
    if (!weekdaysByWeekKey.has(weekKey)) weekdaysByWeekKey.set(weekKey, []);
    weekdaysByWeekKey.get(weekKey)!.push(d);
  }
  const orderedWeekKeys = [...weekdaysByWeekKey.keys()].sort();

  function isShortWeek(employeeId: string, weekKey: string): boolean {
    return weekendEmployeeByWeekKey.get(weekKey) === employeeId;
  }

  // --- Fulltime: pick which weekdays each FT works this week (long week = all, short week = middle days only) ---
  const ftWorkingDates = new Map<string, Set<string>>(); // employeeId -> set of ISO dates
  fulltime.forEach((emp) => ftWorkingDates.set(emp.id, new Set()));
  orderedWeekKeys.forEach((weekKey) => {
    const weekdays = weekdaysByWeekKey.get(weekKey)!;
    fulltime.forEach((emp) => {
      const target = isShortWeek(emp.id, weekKey) ? FT_SHORT_WEEK_DAYS : FT_LONG_WEEK_DAYS;
      const dropCount = Math.max(0, weekdays.length - target);
      const kept = [...weekdays];
      // drop from the end (Friday side) and start (Monday side) alternately, resting around the weekend
      for (let i = 0; i < dropCount; i++) {
        if (i % 2 === 0) kept.pop();
        else kept.shift();
      }
      const set = ftWorkingDates.get(emp.id)!;
      kept.forEach((d) => set.add(toISODate(d)));
    });
  });

  // --- Assign fulltime morning/afternoon per weekday, tracking any gaps left for part-time to fill ---
  const gapsByWeekKey = new Map<string, { date: string; kind: 'morning' | 'afternoon' }[]>();
  const takenSlots = new Set<string>(); // `${date}-${kind}`
  let ftFlipCounter = 0;

  orderedWeekKeys.forEach((weekKey) => {
    const weekdays = weekdaysByWeekKey.get(weekKey)!;
    gapsByWeekKey.set(weekKey, []);
    weekdays.forEach((d) => {
      const iso = toISODate(d);
      const working = fulltime.filter((emp) => ftWorkingDates.get(emp.id)!.has(iso));

      if (working.length >= 2) {
        const [first, second] = working;
        const morningEmp = ftFlipCounter % 2 === 0 ? first : second;
        const afternoonEmp = morningEmp === first ? second : first;
        assignments.push({ date: iso, employeeId: morningEmp.id, shift: SHIFTS.fulltime.morning });
        assignments.push({ date: iso, employeeId: afternoonEmp.id, shift: SHIFTS.fulltime.afternoon });
        takenSlots.add(`${iso}-morning`);
        takenSlots.add(`${iso}-afternoon`);
        ftFlipCounter++;
      } else if (working.length === 1) {
        const emp = working[0];
        const preferMorning = ftFlipCounter % 2 === 0;
        const kind = preferMorning ? 'morning' : 'afternoon';
        const gapKind = preferMorning ? 'afternoon' : 'morning';
        assignments.push({ date: iso, employeeId: emp.id, shift: SHIFTS.fulltime[kind] });
        takenSlots.add(`${iso}-${kind}`);
        gapsByWeekKey.get(weekKey)!.push({ date: iso, kind: gapKind });
        ftFlipCounter++;
      } else {
        gapsByWeekKey.get(weekKey)!.push({ date: iso, kind: 'morning' });
        gapsByWeekKey.get(weekKey)!.push({ date: iso, kind: 'afternoon' });
      }
    });
  });

  // --- Part-time: fill fulltime gaps first, then top up remaining weekly quota with extra support shifts ---
  const ptHours = new Map<string, number>();
  parttime.forEach((emp) => ptHours.set(emp.id, 0));
  assignments.forEach((a) => {
    if (ptHours.has(a.employeeId)) ptHours.set(a.employeeId, (ptHours.get(a.employeeId) ?? 0) + a.shift.hours);
  });

  orderedWeekKeys.forEach((weekKey) => {
    const weekdays = weekdaysByWeekKey.get(weekKey)!;
    const quotaRemaining = new Map<string, number>();
    parttime.forEach((emp) => {
      quotaRemaining.set(emp.id, isShortWeek(emp.id, weekKey) ? PT_SHORT_WEEK_SHIFTS : PT_LONG_WEEK_SHIFTS);
    });

    function assignPtSlot(date: string, kind: 'morning' | 'afternoon') {
      const slotKey = `${date}-${kind}`;
      if (takenSlots.has(slotKey)) return;
      const candidates = parttime.filter((emp) => (quotaRemaining.get(emp.id) ?? 0) > 0);
      if (candidates.length === 0) return;
      const chosen = candidates.sort((a, b) => (ptHours.get(a.id) ?? 0) - (ptHours.get(b.id) ?? 0))[0];
      assignments.push({ date, employeeId: chosen.id, shift: SHIFTS.parttime[kind] });
      takenSlots.add(slotKey);
      quotaRemaining.set(chosen.id, (quotaRemaining.get(chosen.id) ?? 0) - 1);
      ptHours.set(chosen.id, (ptHours.get(chosen.id) ?? 0) + SHIFTS.parttime[kind].hours);
    }

    // Priority 1: cover gaps left by fulltime's short week
    gapsByWeekKey.get(weekKey)!.forEach((gap) => assignPtSlot(gap.date, gap.kind));

    // Priority 2: use any remaining quota as extra support, spread across the week's open slots
    const anyQuotaLeft = () => parttime.some((emp) => (quotaRemaining.get(emp.id) ?? 0) > 0);
    for (const d of weekdays) {
      if (!anyQuotaLeft()) break;
      const iso = toISODate(d);
      (['morning', 'afternoon'] as const).forEach((kind) => {
        if (anyQuotaLeft()) assignPtSlot(iso, kind);
      });
    }
  });

  return assignments;
}

/** Recomputes warnings from the current assignments, so manual edits stay validated too. */
export function computeWarnings(
  year: number,
  month: number,
  employees: Employee[],
  assignments: Assignment[],
): ScheduleWarning[] {
  if (assignments.length === 0) return [];
  const warnings: ScheduleWarning[] = [];
  const totalDays = daysInMonth(year, month);

  // Part-time monthly hour cap
  const hoursByEmployee = new Map<string, number>();
  assignments.forEach((a) => {
    hoursByEmployee.set(a.employeeId, (hoursByEmployee.get(a.employeeId) ?? 0) + a.shift.hours);
  });

  employees
    .filter((e) => e.type === 'parttime')
    .forEach((emp) => {
      const hours = hoursByEmployee.get(emp.id) ?? 0;
      if (hours > PARTTIME_MONTHLY_CAP) {
        const over = hours - PARTTIME_MONTHLY_CAP;
        warnings.push({
          type: 'pt-hours-exceeded',
          employeeId: emp.id,
          message: `${emp.name}: naplánováno ${hours.toFixed(1)} h, limit je ${PARTTIME_MONTHLY_CAP} h (přebytek ${over.toFixed(1)} h). Zvažte převod přebytku do dalšího měsíce.`,
        });
      } else if (hours > PARTTIME_MONTHLY_CAP * 0.9) {
        warnings.push({
          type: 'pt-hours-near-limit',
          employeeId: emp.id,
          message: `${emp.name}: naplánováno ${hours.toFixed(1)} h, blíží se limitu ${PARTTIME_MONTHLY_CAP} h.`,
        });
      }
    });

  // Weekend fairness: everyone should get roughly one weekend a month
  const weekendCountByEmployee = new Map<string, number>();
  const weekendDates = new Set<string>();
  assignments.forEach((a) => {
    if (a.shift.kind === 'weekend') {
      weekendDates.add(a.date);
    }
  });
  assignments
    .filter((a) => a.shift.kind === 'weekend')
    .forEach((a) => {
      const d = new Date(a.date);
      if (d.getDay() === 6) {
        weekendCountByEmployee.set(a.employeeId, (weekendCountByEmployee.get(a.employeeId) ?? 0) + 1);
      }
    });
  if (employees.length > 0) {
    const counts = employees.map((e) => weekendCountByEmployee.get(e.id) ?? 0);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    if (max - min > 1) {
      warnings.push({
        type: 'weekend-uneven',
        message: `Víkendy nejsou letos rozdělené rovnoměrně – rozdíl mezi nejvíc a nejméně vytíženým člověkem je ${max - min} víkendy. Zkontrolujte rozpis.`,
      });
    }
  }

  // Coverage gaps on weekdays (missing morning or afternoon slot)
  for (let day = 1; day <= totalDays; day++) {
    const d = new Date(year, month, day);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const iso = toISODate(d);
    const dayAssignments = assignments.filter((a) => a.date === iso);
    const hasMorning = dayAssignments.some((a) => a.shift.kind === 'morning');
    const hasAfternoon = dayAssignments.some((a) => a.shift.kind === 'afternoon');
    if (!hasMorning) {
      warnings.push({ type: 'coverage-gap', date: iso, message: `${iso}: chybí pokrytí ranní směny.` });
    }
    if (!hasAfternoon) {
      warnings.push({ type: 'coverage-gap', date: iso, message: `${iso}: chybí pokrytí odpolední směny.` });
    }
  }

  return warnings;
}

export function totalHoursByEmployee(assignments: Assignment[], employees: Employee[]): Map<string, number> {
  const map = new Map<string, number>();
  employees.forEach((e) => map.set(e.id, 0));
  assignments.forEach((a) => {
    map.set(a.employeeId, (map.get(a.employeeId) ?? 0) + a.shift.hours);
  });
  return map;
}
