import type { Assignment, Employee, ScheduleOptions, ScheduleWarning, ShiftDefinition, UnavailabilityMap } from './types';
import {
  FT_SHORT_WEEK_REDUCTION,
  FT_TOGETHER_CHANCE,
  FULLTIME_HOURS_TOLERANCE,
  FULLTIME_TARGET_HOURS,
  HOLIDAY_SHIFT,
  PARTTIME_MONTHLY_CAP,
  SHIFTS,
  WEEKEND_SHIFT,
} from './types';
import { getCzechHolidays } from './holidays';

/** Which shift definitions make sense for this employee on a weekday vs. weekend vs. holiday day. */
export function shiftOptionsFor(employee: Employee, isWeekend: boolean, isHoliday = false): ShiftDefinition[] {
  if (isWeekend) return [WEEKEND_SHIFT];
  if (isHoliday) return [HOLIDAY_SHIFT];
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

/** Reasonable bounds for a cross-month compensated target/cap, so a single unusual previous
 * month (a genuine anomaly, not just normal give-and-take) can't swing the next one to an
 * absurd extreme. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Generates a full month's assignments from scratch, following the team's shift rules.
 * `previousAssignments` (the prior calendar month's own generated/edited assignments, if any) lets
 * this month take that history into account: whoever had the weekend last month is deprioritized
 * (not excluded) this month, and fulltime/part-time hour targets are nudged to compensate for
 * whichever direction they missed by last time, so a two-month pair averages out closer to the
 * nominal target/cap than either month chasing it in isolation would. */
export function generateSchedule(
  year: number,
  month: number,
  employees: Employee[],
  unavailability: UnavailabilityMap = {},
  options: ScheduleOptions = {},
  previousAssignments: Assignment[] = [],
): Assignment[] {
  const assignments: Assignment[] = [];
  const fulltime = employees.filter((e) => e.type === 'fulltime');
  const parttime = employees.filter((e) => e.type === 'parttime');
  const totalDays = daysInMonth(year, month);
  const monthIndex = year * 12 + month;

  // What actually happened last month, straight off its real assignments (manual edits included)
  // rather than anything re-derived, so this reacts to what truly happened, not just what was
  // originally generated.
  const previousHoursByEmployee = new Map<string, number>();
  const previousWeekendEmployees = new Set<string>();
  const previousHolidayCounts = new Map<string, number>();
  previousAssignments.forEach((a) => {
    previousHoursByEmployee.set(a.employeeId, (previousHoursByEmployee.get(a.employeeId) ?? 0) + a.shift.hours);
    if (a.shift.kind === 'weekend') previousWeekendEmployees.add(a.employeeId);
    if (a.shift.kind === 'holiday') previousHolidayCounts.set(a.employeeId, (previousHolidayCounts.get(a.employeeId) ?? 0) + 1);
  });

  // Czech public holidays this calendar year - a holiday weekday isn't a normal business day at
  // all (see the skeleton-crew block further down), so it's excluded from weekdaysByWeekKey below
  // the same way weekends already are, keeping it invisible to the regular fulltime/part-time
  // machinery entirely instead of needing special-cased checks scattered through it.
  const holidays = getCzechHolidays(year);

  /** This month's fulltime target, nudged opposite last month's miss (over last time -> a bit
   * lower this time, and vice versa) so a two-month pair averages back toward the nominal 160h
   * instead of each month independently landing wherever its own week/weekend structure allows.
   * Deliberately gentle (a fraction of the miss, tightly clamped): a large one-off deviation (a
   * forced second weekend in a 5-Saturday month, heavy unavailability) is a genuine anomaly that
   * should get flagged by the warning above, not fully cancelled out by an equally large swing
   * the other way, which would just turn one bad month into two. */
  function effectiveFulltimeTarget(empId: string): number {
    const previous = previousHoursByEmployee.get(empId);
    if (previous === undefined) return FULLTIME_TARGET_HOURS;
    const miss = previous - FULLTIME_TARGET_HOURS;
    return clamp(FULLTIME_TARGET_HOURS - miss * 0.3, FULLTIME_TARGET_HOURS - 8, FULLTIME_TARGET_HOURS + 8);
  }

  /** Unlike fulltime's two-sided target, part-time's ~80h is a ceiling, never a floor - landing
   * under it any given month (whether from "long/short week"'s lighter weeks, unavailability, or
   * anything else) is always fine and never something to chase by pushing past 80h later. Only
   * compensate in the one direction that matches the original "soft cap, carries over" idea: if
   * they went over last month (only mandatory fulltime-gap coverage should ever cause that), this
   * month's effective cap comes down to average back toward 80h. */
  function effectivePtCap(empId: string): number {
    const previous = previousHoursByEmployee.get(empId);
    if (previous === undefined || previous <= PARTTIME_MONTHLY_CAP) return PARTTIME_MONTHLY_CAP;
    return clamp(2 * PARTTIME_MONTHLY_CAP - previous, PARTTIME_MONTHLY_CAP - 30, PARTTIME_MONTHLY_CAP);
  }

  /** Whether this employee is specifically marked unavailable for one weekday shift kind. */
  function isUnavailableForKind(employeeId: string, iso: string, kind: 'morning' | 'afternoon'): boolean {
    return unavailability[employeeId]?.[iso]?.has(kind) ?? false;
  }

  /** Whether this employee can't work at all that day - both weekday kinds blocked (or, for a
   * weekend date, the single day-off mark, which the UI always sets on both kinds together). */
  function isUnavailable(employeeId: string, iso: string): boolean {
    const marks = unavailability[employeeId]?.[iso];
    return !!marks && marks.has('morning') && marks.has('afternoon');
  }

  const ptLongShortWeek = options.ptLongShortWeek ?? false;

  // --- Group this month's weekdays by the Monday that starts their calendar week - computed up
  //     front (rather than after weekend assignment) because "long/short week" mode needs each
  //     part-timer's weekly heavy/light role before weekends are even assigned; see below. ---
  const weekdaysByWeekKey = new Map<string, Date[]>();
  for (let day = 1; day <= totalDays; day++) {
    const d = new Date(year, month, day);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    if (holidays.has(toISODate(d))) continue;
    const weekKey = toISODate(mondayOf(d));
    if (!weekdaysByWeekKey.has(weekKey)) weekdaysByWeekKey.set(weekKey, []);
    weekdaysByWeekKey.get(weekKey)!.push(d);
  }
  const orderedWeekKeys = [...weekdaysByWeekKey.keys()].sort();

  const PT_HEAVY_WEEKDAYS = new Set([0, 1, 4]); // Po, Út, Pá (Monday = 0)
  const PT_LIGHT_WEEKDAYS = new Set([2, 3]); // St, Čt

  // Each week, one part-timer is "heavy" (available Mon/Tue/Fri) and the other "light"
  // (available only Wed/Thu), swapping every week - see the pattern-filling block near the
  // bottom for the full rationale. Returns null when the week isn't one of this month's own
  // (a weekend pair can belong to a Monday-Friday week that falls entirely in the previous/next
  // month), since there's no role to speak of for a week outside this month's structure.
  function ptRoleIsLight(empId: string, weekKey: string): boolean | null {
    const weekIndex = orderedWeekKeys.indexOf(weekKey);
    if (weekIndex === -1) return null;
    const empIndex = parttime.findIndex((e) => e.id === empId);
    if (empIndex === -1) return null;
    const isHeavy = (weekIndex + empIndex + monthIndex) % 2 === 0;
    return !isHeavy;
  }

  // Whether this part-timer's weekly role actually permits working this specific weekday - a
  // hard rule with no exceptions once "long/short week" is on: their heavy/light days off are a
  // real commitment, not something mandatory fulltime-gap coverage is allowed to override even as
  // a last resort. Since heavy (Mon/Tue/Fri) and light (Wed/Thu) between them cover every weekday,
  // there's always exactly one part-timer whose role permits any given date, so this never leaves
  // a day with zero eligible part-timer purely because of the role (only real unavailability or
  // the hour cap can still do that). Boundary weeks with no role at all (see ptRoleIsLight) impose
  // no restriction.
  function ptRoleAllowsDay(empId: string, iso: string): boolean {
    if (!ptLongShortWeek) return true;
    const [y, m, d] = iso.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const weekKey = toISODate(mondayOf(dateObj));
    const isLight = ptRoleIsLight(empId, weekKey);
    if (isLight === null) return true;
    const dow = (dateObj.getDay() + 6) % 7; // Monday = 0
    const allowedWeekdays = isLight ? PT_LIGHT_WEEKDAYS : PT_HEAVY_WEEKDAYS;
    return allowedWeekdays.has(dow);
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
    // rotation whenever there's no conflict forcing a swap. Whoever had the weekend last month is
    // moved toward the back of each pair's preference (stable sort keeps everyone else's relative
    // round-robin order intact) - a soft deprioritization, not an exclusion, so consecutive
    // weekends still happen if truly nobody else can cover it, same as any other last resort here.
    const candidateOrder: number[][] = weekendPairs.map((_, idx) => {
      const start = (weekendStart + idx) % n;
      const order = Array.from({ length: n }, (_, k) => (start + k) % n);
      return [...order].sort((a, b) => {
        const aRepeat = previousWeekendEmployees.has(employees[a].id) ? 1 : 0;
        const bRepeat = previousWeekendEmployees.has(employees[b].id) ? 1 : 0;
        return aRepeat - bRepeat;
      });
    });

    const availableIgnoringRole = (pairIdx: number, empIdx: number): boolean =>
      !isUnavailable(employees[empIdx].id, satIsos[pairIdx]) && !isUnavailable(employees[empIdx].id, sunIsos[pairIdx]);

    // In "long/short week" mode, a part-timer can only take a weekend during their own *heavy*
    // week (Mon/Tue/Fri) - that week becomes a genuine "long week" (Mon/Tue/Fri plus the
    // weekend, with Wed/Thu as a clean break in between), while their light weeks (Wed/Thu only)
    // stay a genuine "short week" with the whole rest of the week off. Fulltime is unaffected. A
    // weekend pair's own Mon-Fri week can fall in the previous/next month (ptRoleIsLight returns
    // null then), in which case there's no role to enforce either way.
    const availableFor = (pairIdx: number, empIdx: number): boolean => {
      if (!availableIgnoringRole(pairIdx, empIdx)) return false;
      const emp = employees[empIdx];
      if (ptLongShortWeek && emp.type === 'parttime') {
        const weekKey = toISODate(mondayOf(weekendPairs[pairIdx].saturday));
        if (ptRoleIsLight(emp.id, weekKey) === true) return false;
      }
      return true;
    };

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
        // Nobody satisfies both real availability and the light-role constraint - covering the
        // weekend at all matters more than that pattern, so this tier still respects actual
        // unavailability but relaxes the role requirement.
        bestCredits = Infinity;
        for (const empIdx of candidateOrder[pairIdx]) {
          if (!availableIgnoringRole(pairIdx, empIdx)) continue;
          const credits = weekendCredits.get(employees[empIdx].id)!;
          if (credits < bestCredits) {
            bestCredits = credits;
            best = employees[empIdx];
          }
        }
      }
      if (!best) {
        // Literally nobody is free either day: cover it anyway as an absolute last resort.
        bestCredits = Infinity;
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

  function isShortWeek(employeeId: string, weekKey: string): boolean {
    return weekendEmployeeByWeekKey.get(weekKey)?.has(employeeId) ?? false;
  }

  // --- Holidays: a public holiday falling on a weekday isn't a normal business day - instead of
  //     full morning+afternoon coverage, a single person covers it as a skeleton crew (already
  //     excluded from weekdaysByWeekKey above, so the fulltime/part-time machinery never sees these
  //     dates at all). A holiday landing on a Saturday/Sunday needs no extra handling here - the
  //     weekend block above already covers it the same as any other weekend. Fairness: fewest
  //     holiday shifts so far wins (seeded from last month's actual counts, same idea as
  //     weekendCredits), ties broken randomly. A calendar-position-based round-robin (like the
  //     weekend rotation's own starting point) was tried instead, but since a holiday only shows up
  //     in a given month 0-1 times, the same calendar months (e.g. every January) would then always
  //     land on the same person forever - random tie-breaking avoids that permanent bias, at the
  //     cost of a bit of luck-driven variance in any single year, which evens out over many.
  const holidayCredits = new Map<string, number>();
  employees.forEach((e) => holidayCredits.set(e.id, previousHolidayCounts.get(e.id) ?? 0));

  for (let day = 1; day <= totalDays; day++) {
    const d = new Date(year, month, day);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const iso = toISODate(d);
    if (!holidays.has(iso)) continue;

    const pickBest = (candidates: Employee[]): Employee | undefined => {
      let best: Employee | undefined;
      let bestCredits = Infinity;
      candidates.forEach((emp) => {
        const credits = holidayCredits.get(emp.id)!;
        if (credits < bestCredits || (credits === bestCredits && Math.random() < 0.5)) {
          bestCredits = credits;
          best = emp;
        }
      });
      return best;
    };

    // Prefer someone actually available that day; if literally nobody marked themselves free,
    // cover it anyway as an absolute last resort (same last-resort spirit as the weekend block).
    const best = pickBest(employees.filter((emp) => !isUnavailable(emp.id, iso))) ?? pickBest(employees);
    if (best) {
      assignments.push({ date: iso, employeeId: best.id, shift: HOLIDAY_SHIFT });
      holidayCredits.set(best.id, holidayCredits.get(best.id)! + 1);
    }
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

  // Fulltime: given a monthly hour target, subtracts whatever weekend hours this employee
  // actually has this month, rounds the remaining day count ONCE (not per week, which would
  // multiply rounding error across weeks), then hands it out to weeks one day at a time - always
  // to whichever week currently has the fewest days assigned, within its real capacity - so
  // short/fringe weeks with fewer actual weekdays get their real capacity respected instead of
  // silently losing the shortfall. A week where they cover the weekend has its capacity reduced
  // by `shortWeekReduction`, to rest around that extra load.
  function computeWeekDayTargets(
    empId: string,
    targetHours: number,
    shiftHours: number,
    shortWeekReduction: number,
  ): Map<string, number> {
    const weekendHours = weekendHoursByEmployee.get(empId) ?? 0;
    const idealTotalDays = Math.max(0, targetHours - weekendHours) / shiftHours;
    const totalTargetDays = Math.round(idealTotalDays);

    const capacity = new Map<string, number>();
    orderedWeekKeys.forEach((wk) => {
      const availableCount = weekdaysByWeekKey.get(wk)!.filter((d) => !isUnavailable(empId, toISODate(d))).length;
      const cap = Math.min(5, availableCount);
      capacity.set(wk, isShortWeek(empId, wk) ? Math.max(0, cap - shortWeekReduction) : cap);
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
    return weekTargets;
  }

  const ftWeekTargets = new Map<string, Map<string, number>>(); // employeeId -> weekKey -> target days
  fulltime.forEach((emp) => {
    ftWeekTargets.set(
      emp.id,
      computeWeekDayTargets(emp.id, effectiveFulltimeTarget(emp.id), SHIFTS.fulltime.morning.hours, FT_SHORT_WEEK_REDUCTION),
    );
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
      const canWork = (emp: Employee, kind: 'morning' | 'afternoon') => !isUnavailableForKind(emp.id, iso, kind);

      if (working.length >= 2) {
        const [first, second] = working;
        const firstM = canWork(first, 'morning');
        const firstA = canWork(first, 'afternoon');
        const secondM = canWork(second, 'morning');
        const secondA = canWork(second, 'afternoon');
        // The two ways to split the day: first on mornings + second on afternoons, or reversed.
        const splitFirstMorning = firstM && secondA;
        const splitSecondMorning = secondM && firstA;
        // A kind both of them could plausibly work together, for the "together" chance below.
        const togetherKind: 'morning' | 'afternoon' | null =
          firstM && secondM && firstA && secondA
            ? Math.random() < 0.5
              ? 'morning'
              : 'afternoon'
            : firstM && secondM
              ? 'morning'
              : firstA && secondA
                ? 'afternoon'
                : null;

        if (togetherKind && Math.random() < FT_TOGETHER_CHANCE) {
          // Both take the same shift together; the other shift becomes a gap for part-time to cover.
          const gapKind = togetherKind === 'morning' ? 'afternoon' : 'morning';
          assignments.push({ date: iso, employeeId: first.id, shift: SHIFTS.fulltime[togetherKind] });
          assignments.push({ date: iso, employeeId: second.id, shift: SHIFTS.fulltime[togetherKind] });
          ftTakenSlots.add(`${iso}-${togetherKind}`);
          gaps.push({ date: iso, kind: gapKind });
        } else if (splitFirstMorning && splitSecondMorning) {
          // Either split works - alternate for variety, same as when there's no restriction.
          const morningEmp = ftFlipCounter % 2 === 0 ? first : second;
          const afternoonEmp = morningEmp === first ? second : first;
          assignments.push({ date: iso, employeeId: morningEmp.id, shift: SHIFTS.fulltime.morning });
          assignments.push({ date: iso, employeeId: afternoonEmp.id, shift: SHIFTS.fulltime.afternoon });
          ftTakenSlots.add(`${iso}-morning`);
          ftTakenSlots.add(`${iso}-afternoon`);
        } else if (splitFirstMorning || splitSecondMorning) {
          // Only one split is actually possible given their per-shift restrictions - use it.
          const morningEmp = splitFirstMorning ? first : second;
          const afternoonEmp = morningEmp === first ? second : first;
          assignments.push({ date: iso, employeeId: morningEmp.id, shift: SHIFTS.fulltime.morning });
          assignments.push({ date: iso, employeeId: afternoonEmp.id, shift: SHIFTS.fulltime.afternoon });
          ftTakenSlots.add(`${iso}-morning`);
          ftTakenSlots.add(`${iso}-afternoon`);
        } else {
          // Both are restricted to the same single kind this day (rare) - only one of them can
          // actually be used, so fall back to treating it like a lone worker.
          const solo = firstM || firstA ? first : second;
          const soloKind: 'morning' | 'afternoon' = canWork(solo, 'morning') ? 'morning' : 'afternoon';
          const gapKind = soloKind === 'morning' ? 'afternoon' : 'morning';
          assignments.push({ date: iso, employeeId: solo.id, shift: SHIFTS.fulltime[soloKind] });
          ftTakenSlots.add(`${iso}-${soloKind}`);
          gaps.push({ date: iso, kind: gapKind });
        }
        ftFlipCounter++;
      } else if (working.length === 1) {
        const emp = working[0];
        const canMorning = canWork(emp, 'morning');
        const canAfternoon = canWork(emp, 'afternoon');
        const preferMorning = ftFlipCounter % 2 === 0;
        const kind: 'morning' | 'afternoon' =
          canMorning && canAfternoon ? (preferMorning ? 'morning' : 'afternoon') : canMorning ? 'morning' : 'afternoon';
        const gapKind = kind === 'morning' ? 'afternoon' : 'morning';
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
    // Nobody ever works both a morning and an afternoon shift the same day - the two don't even
    // border each other (13:00-16:00 gap), so covering both would mean working nearly the whole
    // day. This is a hard rule with no last-resort exception: if the only role-eligible,
    // available part-timer already has a shift that date, the slot stays a genuine coverage gap
    // instead.
    const eligible = parttime.filter((emp) => {
      if (isUnavailableForKind(emp.id, date, kind)) return false;
      if (!ptRoleAllowsDay(emp.id, date)) return false;
      if (ptDatesWorked.get(emp.id)!.has(date)) return false;
      if (enforceCap && (ptHours.get(emp.id) ?? 0) + shiftHours > effectivePtCap(emp.id)) return false;
      return true;
    });
    if (eligible.length === 0) return false;
    const chosen = eligible.sort((a, b) => (ptHours.get(a.id) ?? 0) - (ptHours.get(b.id) ?? 0))[0];
    assignments.push({ date, employeeId: chosen.id, shift: SHIFTS.parttime[kind] });
    ptTakenSlots.add(slotKey);
    ptHours.set(chosen.id, (ptHours.get(chosen.id) ?? 0) + shiftHours);
    ptDatesWorked.get(chosen.id)!.add(date);
    return true;
  }

  // --- "Long/short week": each week, one part-timer gets the "heavy" role (available Mon, Tue,
  //     Fri) and the other gets the "light" role (available only Wed, Thu); next week the two
  //     swap, so it's fair over time instead of one person permanently having the lighter week.
  //     A weekend only ever lands on someone's *light* week (see the weekend-assignment block
  //     above), so that a person's heavy weeks stay predictable Mon/Tue/Fri and their light weeks
  //     are the only ones that can also carry the weekend - never both a heavy weekday load and a
  //     weekend the same week. Whether someone actually works one of their role's available days
  //     still depends on their running hour total - once they're at the ~80h cap, further
  //     available days are simply left off instead of forced. ---
  if (parttime.length > 0 && ptLongShortWeek) {
    // Since nobody can take a second shift the same day anymore (see assignPtSlot below), this
    // reserved shift is the role-eligible part-timer's only chance to cover that date - so pick
    // whichever kind fulltime actually left as a gap that day (when there's exactly one), instead
    // of always defaulting to morning. Otherwise a person shows up for a support morning shift
    // while the real gap (the afternoon) goes completely uncovered, purely because of which kind
    // happened to be assigned first.
    orderedWeekKeys.forEach((weekKey) => {
      const weekdays = weekdaysByWeekKey.get(weekKey)!;
      parttime.forEach((emp) => {
        const isLight = ptRoleIsLight(emp.id, weekKey);
        const allowedWeekdays = isLight ? PT_LIGHT_WEEKDAYS : PT_HEAVY_WEEKDAYS;
        weekdays.forEach((d) => {
          const dow = (d.getDay() + 6) % 7; // Monday = 0
          if (!allowedWeekdays.has(dow)) return;
          const iso = toISODate(d);
          const gapKindsThisDate = new Set(gaps.filter((g) => g.date === iso).map((g) => g.kind));
          const kind: 'morning' | 'afternoon' =
            gapKindsThisDate.has('afternoon') && !gapKindsThisDate.has('morning') ? 'afternoon' : 'morning';
          if (isUnavailableForKind(emp.id, iso, kind)) return;
          const shiftHours = SHIFTS.parttime[kind].hours;
          if ((ptHours.get(emp.id) ?? 0) + shiftHours > effectivePtCap(emp.id)) return;
          assignments.push({ date: iso, employeeId: emp.id, shift: SHIFTS.parttime[kind] });
          ptTakenSlots.add(`${iso}-${kind}`);
          ptHours.set(emp.id, (ptHours.get(emp.id) ?? 0) + shiftHours);
          ptDatesWorked.get(emp.id)!.add(iso);
        });
      });
    });
  }

  if (parttime.length > 0) {
    // Fulltime gaps (their short week, or both off) come first among what's left - this is
    // coverage that actually needs filling, so it takes priority over topping up anyone's hours.
    gaps.forEach((gap) => {
      const ok = assignPtSlot(gap.date, gap.kind, true);
      if (!ok) assignPtSlot(gap.date, gap.kind, false);
    });
  }

  // Top up each part-timer's hours toward the ~80h cap, same idea as fulltime working backward
  // from its own target: gaps alone rarely add up to that much, so once they're covered, each
  // part-timer picks up extra morning support shifts (fulltime is typically already there - that
  // overlap is fine, same as it is for gap coverage) on any day they aren't already working, until
  // they'd cross the cap. This can land both part-timers on the same morning together; that's
  // intentional; there just aren't enough weekdays in a month to keep every support shift
  // exclusive to one person and still get both close to their target. "Long/short week" opts out -
  // it already worked backward from the cap on its own terms, week by week.
  if (parttime.length > 0 && !ptLongShortWeek) {
    const allWeekdays: Date[] = [];
    orderedWeekKeys.forEach((wk) => allWeekdays.push(...weekdaysByWeekKey.get(wk)!));
    const shiftHours = SHIFTS.parttime.morning.hours;

    parttime.forEach((emp) => {
      const cap = effectivePtCap(emp.id);
      for (const day of allWeekdays) {
        if ((ptHours.get(emp.id) ?? 0) + shiftHours > cap) break;
        const iso = toISODate(day);
        if (isUnavailableForKind(emp.id, iso, 'morning') || ptDatesWorked.get(emp.id)!.has(iso)) continue;
        assignments.push({ date: iso, employeeId: emp.id, shift: SHIFTS.parttime.morning });
        ptHours.set(emp.id, (ptHours.get(emp.id) ?? 0) + shiftHours);
        ptDatesWorked.get(emp.id)!.add(iso);
      }
    });
  }

  // "Long/short week" catch-up: each part-timer's own already-scheduled weekday days get
  // upgraded in place from the standard 4h shift to the 8h SHIFTS.fulltime version (same shift
  // fulltime uses, break included, since it's the same >6h shift no matter who works it) instead
  // of adding new days, until they approach their own cap - independently of one another, not
  // relative to whichever partner happens to be ahead. The alternating heavy/light roles already
  // give the two part-timers the same number of days in a typical month, so this equalizes them
  // as a side effect; but it must target each person's own cap directly, since two people with
  // identical day counts would otherwise both already "be at the max" relative to each other and
  // neither would ever get upgraded, even miles under the real 80h cap. Earliest days first, for
  // consistency.
  if (parttime.length > 0 && ptLongShortWeek) {
    parttime.forEach((emp) => {
      const target = effectivePtCap(emp.id);
      if ((ptHours.get(emp.id) ?? 0) >= target) return;
      const ownShiftIndexes = assignments
        .map((_, idx) => idx)
        .filter((idx) => {
          const a = assignments[idx];
          return a.employeeId === emp.id && (a.shift.kind === 'morning' || a.shift.kind === 'afternoon');
        })
        .sort((i1, i2) => assignments[i1].date.localeCompare(assignments[i2].date));

      for (const idx of ownShiftIndexes) {
        if ((ptHours.get(emp.id) ?? 0) >= target) break;
        const current = assignments[idx];
        const kind = current.shift.kind as 'morning' | 'afternoon';
        const longShift = SHIFTS.fulltime[kind];
        if (current.shift.hours >= longShift.hours) continue; // already the long version
        const added = longShift.hours - current.shift.hours;
        if ((ptHours.get(emp.id) ?? 0) + added > effectivePtCap(emp.id)) continue;
        assignments[idx] = { ...current, shift: longShift };
        ptHours.set(emp.id, (ptHours.get(emp.id) ?? 0) + added);
      }
    });
  }

  return assignments;
}

/** Recomputes warnings from the current assignments, so manual edits stay validated too. */
const AVAILABILITY_KIND_LABELS: Record<'morning' | 'afternoon' | 'weekend' | 'holiday', string> = {
  morning: 'ranní',
  afternoon: 'odpolední',
  weekend: 'víkendovou',
  holiday: 'sváteční',
};

export function computeWarnings(
  year: number,
  month: number,
  employees: Employee[],
  assignments: Assignment[],
  unavailability: UnavailabilityMap = {},
): ScheduleWarning[] {
  if (assignments.length === 0) return [];
  const warnings: ScheduleWarning[] = [];
  const totalDays = daysInMonth(year, month);
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const holidays = getCzechHolidays(year);

  // Informational reminder whenever someone has a shift on a public holiday - whether it's the
  // generator's own intentional single skeleton-crew assignment or a manually added extra one.
  // Weekend shifts are excluded: a weekend is never a "normal" business day to begin with, so a
  // holiday coinciding with one doesn't change anything worth flagging.
  assignments.forEach((a) => {
    if (a.shift.kind === 'weekend') return;
    const holidayName = holidays.get(a.date);
    if (!holidayName) return;
    const emp = employeeById.get(a.employeeId);
    if (!emp) return;
    warnings.push({
      type: 'holiday-shift',
      employeeId: a.employeeId,
      date: a.date,
      message: `${emp.name}: má naplánovanou směnu na ${a.date} (${holidayName}).`,
    });
  });

  // Manual edits (moving/adding an assignment by hand) can put someone on a shift they've
  // marked themselves unavailable for - the generator itself never does this, so it's only
  // ever a sign of a manual edit worth double-checking.
  assignments.forEach((a) => {
    const emp = employeeById.get(a.employeeId);
    if (!emp) return;
    const marks = unavailability[a.employeeId]?.[a.date];
    if (!marks) return;
    const conflict =
      a.shift.kind === 'weekend' || a.shift.kind === 'holiday'
        ? marks.has('morning') && marks.has('afternoon')
        : marks.has(a.shift.kind);
    if (conflict) {
      warnings.push({
        type: 'availability-conflict',
        employeeId: a.employeeId,
        date: a.date,
        message: `${emp.name}: má naplánovanou ${AVAILABILITY_KIND_LABELS[a.shift.kind]} směnu na ${a.date}, i když je ten den označen jako nedostupný.`,
      });
    }
  });

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

  // Fulltime monthly hour limit - same idea as part-time's cap: only flag actually going over,
  // not landing a bit under (which needs no correction). A little over is normal day-granularity
  // rounding; only a genuine overshoot (a forced second weekend in a 5-Saturday month, etc.) warrants this.
  employees
    .filter((e) => e.type === 'fulltime')
    .forEach((emp) => {
      const hours = hoursByEmployee.get(emp.id) ?? 0;
      const over = hours - FULLTIME_TARGET_HOURS;
      if (over > FULLTIME_HOURS_TOLERANCE) {
        warnings.push({
          type: 'ft-hours-deviation',
          employeeId: emp.id,
          message: `${emp.name}: naplánováno ${hours.toFixed(1)} h, limit je ${FULLTIME_TARGET_HOURS} h (přebytek ${over.toFixed(1)} h).`,
        });
      }
    });

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
    // A weekday holiday deliberately gets only the single skeleton-crew shift, not full
    // morning+afternoon coverage - that's the intended state (see the holiday-shift warning
    // above), not something missing to flag.
    if (holidays.has(iso)) continue;
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
