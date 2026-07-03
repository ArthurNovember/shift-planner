import type { Assignment, Employee, ScheduleOptions, ScheduleWarning, ShiftDefinition, UnavailabilityMap } from './types';
import {
  FT_SHORT_WEEK_REDUCTION,
  FT_TOGETHER_CHANCE,
  FULLTIME_HOURS_TOLERANCE,
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

  // The same person always covers both Saturday and Sunday of a weekend - never split across
  // two different people. Every employee should get exactly one weekend turn a month whenever
  // that's physically possible - a simple one-pass round-robin can't discover that, though: if
  // someone's expected turn lands on a weekend they're unavailable for, a one-pass assignment
  // just skips them for the rest of the month even when swapping them onto a *different* weekend
  // (and shuffling whoever had that one) would have covered everyone. This runs a small
  // bipartite matching (Kuhn's algorithm, employees vs. weekend pairs - tiny N so a plain DFS
  // with augmenting paths is instant) to find the assignment that covers the most pairs with
  // distinct people. Only genuine overflow (more weekend pairs than employees in a month, e.g. a
  // 31-day month with 5 Saturdays) falls back to giving someone a second turn, and even then
  // it's whoever currently has the fewest, so repeats rotate fairly across different months.
  const weekendEmployeeByWeekKey = new Map<string, Set<string>>();

  if (employees.length > 0 && weekendPairs.length > 0) {
    const weekendStart = monthIndex % employees.length;
    const n = employees.length;
    const m = weekendPairs.length;
    const satIsos = weekendPairs.map((p) => toISODate(p.saturday));
    const sunIsos = weekendPairs.map((p) => toISODate(p.sunday));

    // Preferred candidate order per pair (round-robin), so the matching still favors the usual
    // rotation whenever there's no conflict forcing a swap.
    const candidateOrder: number[][] = weekendPairs.map((_, idx) => {
      const start = (weekendStart + idx) % n;
      return Array.from({ length: n }, (_, k) => (start + k) % n);
    });

    const availableFor = (pairIdx: number, empIdx: number): boolean =>
      !isUnavailable(employees[empIdx].id, satIsos[pairIdx]) && !isUnavailable(employees[empIdx].id, sunIsos[pairIdx]);

    const matchEmployeeOfPair = new Array<number>(m).fill(-1);
    const matchPairOfEmployee = new Array<number>(n).fill(-1);

    function tryAugment(pairIdx: number, visited: boolean[]): boolean {
      for (const empIdx of candidateOrder[pairIdx]) {
        if (visited[empIdx] || !availableFor(pairIdx, empIdx)) continue;
        visited[empIdx] = true;
        if (matchPairOfEmployee[empIdx] === -1 || tryAugment(matchPairOfEmployee[empIdx], visited)) {
          matchPairOfEmployee[empIdx] = pairIdx;
          matchEmployeeOfPair[pairIdx] = empIdx;
          return true;
        }
      }
      return false;
    }

    for (let pairIdx = 0; pairIdx < m; pairIdx++) {
      tryAugment(pairIdx, new Array(n).fill(false));
    }

    const weekendCredits = new Map<string, number>();
    employees.forEach((e) => weekendCredits.set(e.id, 0));

    function assignPair(pairIdx: number, emp: Employee): void {
      const weekKey = toISODate(mondayOf(weekendPairs[pairIdx].saturday));
      assignments.push({ date: satIsos[pairIdx], employeeId: emp.id, shift: WEEKEND_SHIFT });
      assignments.push({ date: sunIsos[pairIdx], employeeId: emp.id, shift: WEEKEND_SHIFT });
      if (!weekendEmployeeByWeekKey.has(weekKey)) weekendEmployeeByWeekKey.set(weekKey, new Set());
      weekendEmployeeByWeekKey.get(weekKey)!.add(emp.id);
      weekendCredits.set(emp.id, weekendCredits.get(emp.id)! + 1);
    }

    for (let pairIdx = 0; pairIdx < m; pairIdx++) {
      if (matchEmployeeOfPair[pairIdx] !== -1) assignPair(pairIdx, employees[matchEmployeeOfPair[pairIdx]]);
    }

    // Any pair the matching couldn't cover (genuine overflow, or nobody free either day) falls
    // back to whoever currently has the fewest weekend turns credited so far.
    for (let pairIdx = 0; pairIdx < m; pairIdx++) {
      if (matchEmployeeOfPair[pairIdx] !== -1) continue;
      let best: Employee | undefined;
      let bestCredits = Infinity;
      for (const empIdx of candidateOrder[pairIdx]) {
        if (!availableFor(pairIdx, empIdx)) continue;
        const credits = weekendCredits.get(employees[empIdx].id)!;
        if (credits < bestCredits) {
          bestCredits = credits;
          best = employees[empIdx];
        }
      }
      if (!best) {
        // Literally nobody is free either day: cover it anyway as an absolute last resort.
        for (const empIdx of candidateOrder[pairIdx]) {
          const credits = weekendCredits.get(employees[empIdx].id)!;
          if (credits < bestCredits) {
            bestCredits = credits;
            best = employees[empIdx];
          }
        }
      }
      if (best) assignPair(pairIdx, best);
    }
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
    return weekendEmployeeByWeekKey.get(weekKey)?.has(employeeId) ?? false;
  }

  // --- Fulltime: work backwards from the ~160h/month target to figure out how many days
  //     each week an FT actually needs, so the monthly total lands as close as possible to
  //     it regardless of how many weeks/weekdays this particular month has. The month's
  //     total day target is rounded only ONCE, then handed out to weeks one day at a time
  //     (always to whichever week currently has the fewest days assigned, within its real
  //     capacity) - rounding a per-week count and reusing it for every week would multiply
  //     that rounding error by the number of weeks, and short/fringe weeks with fewer actual
  //     weekdays need their real capacity respected or the shortfall silently disappears
  //     instead of moving to a week that has room. A week where they cover the weekend
  //     (~19h) has its capacity reduced by a fixed handful, to rest around that extra load. ---
  // Weekend hours actually landing on each employee this month, read straight off the real
  // assignments rather than re-derived from week keys - a weekend pair's own calendar week
  // (Mon-Fri) can fall entirely in the previous/next month (e.g. a Saturday on the 1st), in
  // which case it has no entry in orderedWeekKeys at all, and re-deriving from week keys would
  // silently drop that weekend's hours from the target instead of discounting them.
  const weekendHoursByEmployee = new Map<string, number>();
  assignments.forEach((a) => {
    if (a.shift.kind !== 'weekend') return;
    weekendHoursByEmployee.set(a.employeeId, (weekendHoursByEmployee.get(a.employeeId) ?? 0) + a.shift.hours);
  });

  const ftWeekTargets = new Map<string, Map<string, number>>(); // employeeId -> weekKey -> target days
  fulltime.forEach((emp) => {
    const weekendHours = weekendHoursByEmployee.get(emp.id) ?? 0;
    const idealTotalDays = Math.max(0, FULLTIME_TARGET_HOURS - weekendHours) / SHIFTS.fulltime.morning.hours;
    const totalTargetDays = Math.round(idealTotalDays);

    const capacity = new Map<string, number>();
    orderedWeekKeys.forEach((wk) => {
      const availableCount = weekdaysByWeekKey.get(wk)!.filter((d) => !isUnavailable(emp.id, toISODate(d))).length;
      const cap = Math.min(5, availableCount);
      capacity.set(wk, isShortWeek(emp.id, wk) ? Math.max(0, cap - FT_SHORT_WEEK_REDUCTION) : cap);
    });

    const totalCapacity = [...capacity.values()].reduce((a, b) => a + b, 0);
    let remaining = Math.min(totalTargetDays, totalCapacity);

    const weekTargets = new Map<string, number>();
    orderedWeekKeys.forEach((wk) => weekTargets.set(wk, 0));
    while (remaining > 0) {
      let bestWeek: string | null = null;
      let bestAssigned = Infinity;
      for (const wk of orderedWeekKeys) {
        const assigned = weekTargets.get(wk)!;
        if (assigned < capacity.get(wk)! && assigned < bestAssigned) {
          bestAssigned = assigned;
          bestWeek = wk;
        }
      }
      if (!bestWeek) break;
      weekTargets.set(bestWeek, weekTargets.get(bestWeek)! + 1);
      remaining--;
    }
    ftWeekTargets.set(emp.id, weekTargets);
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
      const target = ftWeekTargets.get(emp.id)!.get(weekKey) ?? 0;
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
    // Fulltime gaps (their short week, or both off) come first - this is the coverage that
    // actually needs filling, so it takes priority over topping up anyone's hours.
    gaps.forEach((gap) => {
      let ok = assignPtSlot(gap.date, gap.kind, true, false);
      if (!ok) ok = assignPtSlot(gap.date, gap.kind, false, false);
      if (!ok) assignPtSlot(gap.date, gap.kind, false, true);
    });
  }

  // Top up each part-timer's hours toward the ~80h cap, same idea as fulltime working backward
  // from its own target: gaps alone rarely add up to that much, so once they're covered, each
  // part-timer picks up extra morning support shifts (fulltime is typically already there - that
  // overlap is fine, same as it is for gap coverage) on any day they aren't already working,
  // until they'd cross the cap. This can land both part-timers on the same morning together;
  // that's intentional; there just aren't enough weekdays in a month to keep every support shift
  // exclusive to one person and still get both close to their target. Regularity mode opts out -
  // it deliberately keeps a light, fixed quota instead of hunting for the cap.
  if (parttime.length > 0 && !options.ptRegularityMode) {
    const allWeekdays: Date[] = [];
    orderedWeekKeys.forEach((wk) => allWeekdays.push(...weekdaysByWeekKey.get(wk)!));
    const shiftHours = SHIFTS.parttime.morning.hours;

    parttime.forEach((emp) => {
      for (const day of allWeekdays) {
        if ((ptHours.get(emp.id) ?? 0) + shiftHours > PARTTIME_MONTHLY_CAP) break;
        const iso = toISODate(day);
        if (isUnavailable(emp.id, iso) || ptDatesWorked.get(emp.id)!.has(iso)) continue;
        assignments.push({ date: iso, employeeId: emp.id, shift: SHIFTS.parttime.morning });
        ptHours.set(emp.id, (ptHours.get(emp.id) ?? 0) + shiftHours);
        ptDatesWorked.get(emp.id)!.add(iso);
      }
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

  // The generator deliberately keeps part-time hours close to the cap (see the hour top-up
  // above), so sitting near it is the normal, intended state - only actually going over it
  // (which only manual edits after generation can cause) is worth flagging.
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
      }
    });

  // Fulltime monthly hour target - a two-sided target rather than a hard cap (some months
  // land a bit under, some a bit over, by design), so only flag a genuinely large drift.
  employees
    .filter((e) => e.type === 'fulltime')
    .forEach((emp) => {
      const hours = hoursByEmployee.get(emp.id) ?? 0;
      const diff = hours - FULLTIME_TARGET_HOURS;
      if (Math.abs(diff) > FULLTIME_HOURS_TOLERANCE) {
        warnings.push({
          type: 'ft-hours-deviation',
          employeeId: emp.id,
          message:
            diff > 0
              ? `${emp.name}: naplánováno ${hours.toFixed(1)} h, cíl je ${FULLTIME_TARGET_HOURS} h (přebytek ${diff.toFixed(1)} h).`
              : `${emp.name}: naplánováno ${hours.toFixed(1)} h, cíl je ${FULLTIME_TARGET_HOURS} h (podstav ${Math.abs(diff).toFixed(1)} h).`,
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
