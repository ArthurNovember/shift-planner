import type { Assignment, Employee, ScheduleWarning, ShiftDefinition, UnavailabilityMap } from './types';
import { FT_LONG_WEEK_DAYS, FT_SHORT_WEEK_DAYS, PARTTIME_MONTHLY_CAP, SHIFTS, WEEKEND_SHIFT } from './types';

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
export function generateSchedule(
  year: number,
  month: number,
  employees: Employee[],
  unavailability: UnavailabilityMap = {},
): Assignment[] {
  const assignments: Assignment[] = [];
  const fulltime = employees.filter((e) => e.type === 'fulltime');
  const parttime = employees.filter((e) => e.type === 'parttime');
  const totalDays = daysInMonth(year, month);
  const monthIndex = year * 12 + month;

  function isUnavailable(employeeId: string, iso: string): boolean {
    return unavailability[employeeId]?.has(iso) ?? false;
  }

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
      const satIso = toISODate(pair.saturday);
      const sunIso = toISODate(pair.sunday);
      const weekKey = toISODate(mondayOf(pair.saturday));
      const start = (weekendStart + idx) % employees.length;

      let chosen: Employee | undefined;
      for (let k = 0; k < employees.length; k++) {
        const candidate = employees[(start + k) % employees.length];
        if (!isUnavailable(candidate.id, satIso) && !isUnavailable(candidate.id, sunIso)) {
          chosen = candidate;
          break;
        }
      }

      if (chosen) {
        assignments.push({ date: satIso, employeeId: chosen.id, shift: WEEKEND_SHIFT });
        assignments.push({ date: sunIso, employeeId: chosen.id, shift: WEEKEND_SHIFT });
        weekendEmployeeByWeekKey.set(weekKey, chosen.id);
      } else {
        // nobody is free for the whole weekend: cover each day independently if possible
        const satEmp = employees.find((e) => !isUnavailable(e.id, satIso));
        const sunEmp = employees.find((e) => !isUnavailable(e.id, sunIso));
        if (satEmp) assignments.push({ date: satIso, employeeId: satEmp.id, shift: WEEKEND_SHIFT });
        if (sunEmp) assignments.push({ date: sunIso, employeeId: sunEmp.id, shift: WEEKEND_SHIFT });
        if (satEmp) weekendEmployeeByWeekKey.set(weekKey, satEmp.id);
      }
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

  // --- Fulltime: pick which weekdays each FT works this week (long week = all available,
  //     short week = middle days only), skipping any date they've marked unavailable ---
  const ftWorkingDates = new Map<string, Set<string>>(); // employeeId -> set of ISO dates
  fulltime.forEach((emp) => ftWorkingDates.set(emp.id, new Set()));
  orderedWeekKeys.forEach((weekKey) => {
    const weekdays = weekdaysByWeekKey.get(weekKey)!;
    fulltime.forEach((emp) => {
      const available = weekdays.filter((d) => !isUnavailable(emp.id, toISODate(d)));
      const target = isShortWeek(emp.id, weekKey) ? FT_SHORT_WEEK_DAYS : FT_LONG_WEEK_DAYS;
      const dropCount = Math.max(0, available.length - target);
      const kept = [...available];
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
  const gaps: { date: string; kind: 'morning' | 'afternoon' }[] = [];
  const ftTakenSlots = new Set<string>(); // `${date}-${kind}`, fulltime coverage only
  let ftFlipCounter = 0;

  orderedWeekKeys.forEach((weekKey) => {
    const weekdays = weekdaysByWeekKey.get(weekKey)!;
    weekdays.forEach((d) => {
      const iso = toISODate(d);
      const working = fulltime.filter((emp) => ftWorkingDates.get(emp.id)!.has(iso));

      if (working.length >= 2) {
        const [first, second] = working;
        const morningEmp = ftFlipCounter % 2 === 0 ? first : second;
        const afternoonEmp = morningEmp === first ? second : first;
        assignments.push({ date: iso, employeeId: morningEmp.id, shift: SHIFTS.fulltime.morning });
        assignments.push({ date: iso, employeeId: afternoonEmp.id, shift: SHIFTS.fulltime.afternoon });
        ftTakenSlots.add(`${iso}-morning`);
        ftTakenSlots.add(`${iso}-afternoon`);
        ftFlipCounter++;
      } else if (working.length === 1) {
        const emp = working[0];
        const preferMorning = ftFlipCounter % 2 === 0;
        const kind = preferMorning ? 'morning' : 'afternoon';
        const gapKind = preferMorning ? 'afternoon' : 'morning';
        assignments.push({ date: iso, employeeId: emp.id, shift: SHIFTS.fulltime[kind] });
        ftTakenSlots.add(`${iso}-${kind}`);
        gaps.push({ date: iso, kind: gapKind });
        ftFlipCounter++;
      } else {
        gaps.push({ date: iso, kind: 'morning' });
        gaps.push({ date: iso, kind: 'afternoon' });
      }
    });
  });

  // --- Part-time: cover fulltime gaps first, then keep adding support shifts (even alongside
  //     fulltime coverage) until each part-timer's monthly hours approach the target cap ---
  const ptHours = new Map<string, number>();
  parttime.forEach((emp) => ptHours.set(emp.id, 0));
  assignments.forEach((a) => {
    if (ptHours.has(a.employeeId)) ptHours.set(a.employeeId, (ptHours.get(a.employeeId) ?? 0) + a.shift.hours);
  });

  const ptTakenSlots = new Set<string>(); // `${date}-${kind}`, prevents double-booking two part-timers on one slot
  const ptDatesWorked = new Map<string, Set<string>>(); // employeeId -> dates they already have a shift on
  parttime.forEach((emp) => ptDatesWorked.set(emp.id, new Set()));

  function assignPtSlot(date: string, kind: 'morning' | 'afternoon', enforceCap: boolean): boolean {
    const slotKey = `${date}-${kind}`;
    if (ptTakenSlots.has(slotKey)) return false;
    // The afternoon only ever has one person on duty: part-time can only take it when
    // fulltime isn't already covering that afternoon (a genuine gap). Mornings may overlap,
    // since fulltime + part-time together during the morning is welcome extra support.
    if (kind === 'afternoon' && ftTakenSlots.has(`${date}-afternoon`)) return false;
    const shiftHours = SHIFTS.parttime[kind].hours;
    const eligible = parttime.filter((emp) => {
      if (isUnavailable(emp.id, date)) return false;
      if (enforceCap && (ptHours.get(emp.id) ?? 0) + shiftHours > PARTTIME_MONTHLY_CAP) return false;
      return true;
    });
    if (eligible.length === 0) return false;
    // Prefer someone who doesn't already work that day, so one person doesn't get both shifts
    const freshCandidates = eligible.filter((emp) => !ptDatesWorked.get(emp.id)!.has(date));
    const candidates = freshCandidates.length > 0 ? freshCandidates : eligible;
    const chosen = candidates.sort((a, b) => (ptHours.get(a.id) ?? 0) - (ptHours.get(b.id) ?? 0))[0];
    assignments.push({ date, employeeId: chosen.id, shift: SHIFTS.parttime[kind] });
    ptTakenSlots.add(slotKey);
    ptHours.set(chosen.id, (ptHours.get(chosen.id) ?? 0) + shiftHours);
    ptDatesWorked.get(chosen.id)!.add(date);
    return true;
  }

  if (parttime.length > 0) {
    // Priority 1: cover gaps left by fulltime's short week (mandatory coverage, cap allowed to slip if needed)
    gaps.forEach((gap) => {
      const ok = assignPtSlot(gap.date, gap.kind, true);
      if (!ok) assignPtSlot(gap.date, gap.kind, false);
    });

    // Priority 2: keep adding morning support shifts - even on days fulltime already covers
    // the morning - spreading across the month until every part-timer nears the cap. The
    // afternoon is never doubled up, so it only gets filled here through leftover gaps above.
    orderedWeekKeys.forEach((weekKey) => {
      weekdaysByWeekKey.get(weekKey)!.forEach((d) => {
        assignPtSlot(toISODate(d), 'morning', true);
      });
    });
  }

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

  // Coverage gaps: missing morning/afternoon slot on weekdays, missing weekend coverage
  for (let day = 1; day <= totalDays; day++) {
    const d = new Date(year, month, day);
    const dow = d.getDay();
    const iso = toISODate(d);
    const dayAssignments = assignments.filter((a) => a.date === iso);
    if (dow === 0 || dow === 6) {
      if (!dayAssignments.some((a) => a.shift.kind === 'weekend')) {
        warnings.push({ type: 'coverage-gap', date: iso, message: `${iso}: chybí pokrytí víkendové směny.` });
      }
      continue;
    }
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
