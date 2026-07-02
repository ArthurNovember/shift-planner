import type { Assignment, Employee, ScheduleOptions, ScheduleWarning, ShiftDefinition, UnavailabilityMap } from './types';
import {
  FT_SHORT_WEEK_REDUCTION,
  FT_TOGETHER_CHANCE,
  FULLTIME_TARGET_HOURS,
  PARTTIME_MONTHLY_CAP,
  PT_REGULAR_LONG_WEEK_SHIFTS,
  PT_SHORT_WEEK_REDUCTION,
  SHIFTS,
  WEEKEND_SHIFT,
} from './types';

/** Which shift definitions make sense for this employee on a weekday vs. weekend day. */
export function shiftOptionsFor(employee: Employee, isWeekend: boolean): ShiftDefinition[] {
  if (isWeekend) return [WEEKEND_SHIFT];
  return [SHIFTS[employee.type].morning, SHIFTS[employee.type].afternoon];
}

/** Hours between two "HH:MM" times, for when someone leaves early or stays late. */
export function hoursBetween(start: string, end: string): number {
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const minutes = endH * 60 + endM - (startH * 60 + startM);
  return Math.max(0, minutes) / 60;
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
  options: ScheduleOptions = {},
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

  // --- Fulltime: work backwards from the ~160h/month target to figure out how many days a
  //     week each FT actually needs, so the total lands close to it regardless of how many
  //     weeks/weekdays this particular month has. A week where they cover the weekend (~19h)
  //     gets fewer weekday shifts, to rest around that extra load. ---
  const weeksCount = Math.max(1, orderedWeekKeys.length);
  const ftDayTargets = new Map<string, { longDays: number; shortDays: number }>();
  fulltime.forEach((emp) => {
    const shortWeeksCount = orderedWeekKeys.filter((wk) => isShortWeek(emp.id, wk)).length;
    const weekendHours = shortWeeksCount * WEEKEND_SHIFT.hours * 2;
    const targetTotalDays = Math.round(Math.max(0, FULLTIME_TARGET_HOURS - weekendHours) / SHIFTS.fulltime.morning.hours);
    const longDays = Math.min(
      5,
      Math.max(0, Math.round((targetTotalDays + FT_SHORT_WEEK_REDUCTION * shortWeeksCount) / weeksCount)),
    );
    const shortDays = Math.max(0, longDays - FT_SHORT_WEEK_REDUCTION);
    ftDayTargets.set(emp.id, { longDays, shortDays });
  });

  // One FT always trims days off from the Friday side, the other from the Monday side, so
  // their days off land on opposite ends and (as long as the two targets add up to at least
  // the week's length) never coincide on the same day.
  const ftWorkingDates = new Map<string, Set<string>>(); // employeeId -> set of ISO dates
  fulltime.forEach((emp) => ftWorkingDates.set(emp.id, new Set()));
  orderedWeekKeys.forEach((weekKey) => {
    const weekdays = weekdaysByWeekKey.get(weekKey)!;
    fulltime.forEach((emp, empIndex) => {
      const available = weekdays.filter((d) => !isUnavailable(emp.id, toISODate(d)));
      const { longDays, shortDays } = ftDayTargets.get(emp.id)!;
      const target = isShortWeek(emp.id, weekKey) ? shortDays : longDays;
      const offCount = Math.max(0, available.length - target);
      // even index: trim off days from the end (Friday side); odd index: from the start (Monday side)
      const kept =
        offCount === 0
          ? available
          : empIndex % 2 === 0
            ? available.slice(0, available.length - offCount)
            : available.slice(offCount);
      const set = ftWorkingDates.get(emp.id)!;
      kept.forEach((d) => set.add(toISODate(d)));
    });
  });

  // Safety net: the opposite-end trimming only avoids both being off the same day when both
  // start from the same full week. Personal unavailability can still knock both out on one
  // date - if that happens and at least one of them is actually free that day, pull them back
  // in rather than leaving the day to part-time alone (part-time morning ends at 13:00 and
  // afternoon doesn't start until 16:00, so a fulltime-free day leaves a real gap in between).
  if (fulltime.length >= 2) {
    orderedWeekKeys.forEach((weekKey) => {
      weekdaysByWeekKey.get(weekKey)!.forEach((d) => {
        const iso = toISODate(d);
        const anyWorking = fulltime.some((emp) => ftWorkingDates.get(emp.id)!.has(iso));
        if (anyWorking) return;
        const availableEmp = fulltime.find((emp) => !isUnavailable(emp.id, iso));
        if (availableEmp) ftWorkingDates.get(availableEmp.id)!.add(iso);
      });
    });
  }

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
        if (Math.random() < FT_TOGETHER_CHANCE) {
          // Both take the same shift together; the other shift becomes a gap for part-time to cover.
          const kind: 'morning' | 'afternoon' = Math.random() < 0.5 ? 'morning' : 'afternoon';
          const gapKind = kind === 'morning' ? 'afternoon' : 'morning';
          assignments.push({ date: iso, employeeId: first.id, shift: SHIFTS.fulltime[kind] });
          assignments.push({ date: iso, employeeId: second.id, shift: SHIFTS.fulltime[kind] });
          ftTakenSlots.add(`${iso}-${kind}`);
          gaps.push({ date: iso, kind: gapKind });
        } else {
          const morningEmp = ftFlipCounter % 2 === 0 ? first : second;
          const afternoonEmp = morningEmp === first ? second : first;
          assignments.push({ date: iso, employeeId: morningEmp.id, shift: SHIFTS.fulltime.morning });
          assignments.push({ date: iso, employeeId: afternoonEmp.id, shift: SHIFTS.fulltime.afternoon });
          ftTakenSlots.add(`${iso}-morning`);
          ftTakenSlots.add(`${iso}-afternoon`);
        }
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

  function assignPtSlot(
    date: string,
    kind: 'morning' | 'afternoon',
    enforceCap: boolean,
    allowSameDayDouble: boolean,
  ): boolean {
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
    // Nobody should work both shifts in one day - prefer someone who isn't already working
    // that date. Only fall back to doubling someone up when the caller allows it (mandatory
    // coverage gaps); optional support shifts skip the day entirely instead.
    const freshCandidates = eligible.filter((emp) => !ptDatesWorked.get(emp.id)!.has(date));
    const candidates = freshCandidates.length > 0 ? freshCandidates : allowSameDayDouble ? eligible : [];
    if (candidates.length === 0) return false;
    const chosen = candidates.sort((a, b) => (ptHours.get(a.id) ?? 0) - (ptHours.get(b.id) ?? 0))[0];
    assignments.push({ date, employeeId: chosen.id, shift: SHIFTS.parttime[kind] });
    ptTakenSlots.add(slotKey);
    ptHours.set(chosen.id, (ptHours.get(chosen.id) ?? 0) + shiftHours);
    ptDatesWorked.get(chosen.id)!.add(date);
    return true;
  }

  // --- Regularity mode: give each part-timer a fixed recurring weekly morning pattern instead
  //     of the greedy fill below, so their shifts land on the same weekdays every week. The
  //     two patterns never overlap the same date - whoever isn't scheduled that day is always
  //     free to step in if a fulltime gap lands on it, without doubling anyone up. Since two
  //     equal quotas can't both fit a 5-day week without overlap, priority alternates monthly
  //     so it averages out fair over time. Deliberately a light, fixed quota (not a hunt for
  //     80h) - reaching the cap on morning-only shifts would mean working nearly every
  //     weekday, which defeats the point of a genuinely regular, lighter rhythm. ---
  if (parttime.length > 0 && options.ptRegularityMode) {
    const ptDayTargets = new Map<string, { longShifts: number; shortShifts: number }>();
    parttime.forEach((emp) => {
      const longShifts = PT_REGULAR_LONG_WEEK_SHIFTS;
      const shortShifts = Math.max(0, longShifts - PT_SHORT_WEEK_REDUCTION);
      ptDayTargets.set(emp.id, { longShifts, shortShifts });
    });

    const priorityIndex = monthIndex % parttime.length;
    const claimOrder = parttime
      .map((_, i) => i)
      .sort((a, b) => (a - priorityIndex + parttime.length) % parttime.length - ((b - priorityIndex + parttime.length) % parttime.length));

    orderedWeekKeys.forEach((weekKey) => {
      const weekdays = weekdaysByWeekKey.get(weekKey)!;
      const claimedThisWeek = new Set<string>();

      claimOrder.forEach((empIndex) => {
        const emp = parttime[empIndex];
        const available = weekdays.filter(
          (d) => !isUnavailable(emp.id, toISODate(d)) && !claimedThisWeek.has(toISODate(d)),
        );
        const { longShifts, shortShifts } = ptDayTargets.get(emp.id)!;
        let kept: Date[];
        if (isShortWeek(emp.id, weekKey)) {
          // Their own weekend week: rest around it by keeping the middle days only.
          const target = Math.min(available.length, shortShifts);
          const offCount = Math.max(0, available.length - target);
          kept = [...available];
          for (let i = 0; i < offCount; i++) {
            if (i % 2 === 0) kept.pop();
            else kept.shift();
          }
        } else {
          // Regular week: this person anchors to the same side of the week every time.
          const target = Math.min(available.length, longShifts);
          kept = empIndex % 2 === 0 ? available.slice(0, target) : available.slice(available.length - target);
        }
        kept.forEach((d) => {
          const iso = toISODate(d);
          claimedThisWeek.add(iso);
          assignments.push({ date: iso, employeeId: emp.id, shift: SHIFTS.parttime.morning });
          ptTakenSlots.add(`${iso}-morning`);
          ptHours.set(emp.id, (ptHours.get(emp.id) ?? 0) + SHIFTS.parttime.morning.hours);
          ptDatesWorked.get(emp.id)!.add(iso);
        });
      });
    });
  }

  if (parttime.length > 0) {
    // Priority 1: cover gaps left by fulltime's short week (mandatory coverage - allowed to
    // double someone up or slip past the cap as a last resort, since the shift must be covered)
    gaps.forEach((gap) => {
      let ok = assignPtSlot(gap.date, gap.kind, true, false);
      if (!ok) ok = assignPtSlot(gap.date, gap.kind, false, false);
      if (!ok) assignPtSlot(gap.date, gap.kind, false, true);
    });

    // Priority 2: keep adding morning support shifts - even on days fulltime already covers
    // the morning - spreading across the month until every part-timer nears the cap. The
    // afternoon is never doubled up, so it only gets filled here through leftover gaps above.
    // Optional, so a day is simply skipped rather than giving someone a second shift that day.
    // Skipped in regularity mode, since the fixed pattern above already covers their hours.
    if (!options.ptRegularityMode) {
      orderedWeekKeys.forEach((weekKey) => {
        weekdaysByWeekKey.get(weekKey)!.forEach((d) => {
          assignPtSlot(toISODate(d), 'morning', true, false);
        });
      });
    }
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
