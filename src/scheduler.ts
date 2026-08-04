import type { Assignment, Employee, ScheduleOptions, ScheduleWarning, ShiftDefinition, UnavailabilityMap } from './types';
import {
  FT_POST_WEEKEND_RECOVERY_DAYS,
  FT_SHORT_WEEK_REDUCTION,
  FT_TOGETHER_CHANCE,
  FULLTIME_HOURS_TOLERANCE,
  FULLTIME_TARGET_HOURS,
  HOLIDAY_SHIFT,
  MAX_CONSECUTIVE_SHIFTS,
  PARTTIME_MONTHLY_CAP,
  SHIFTS,
  WEEKEND_SHIFT,
} from './types';
import { getClosedDays, getCzechHolidays } from './holidays';

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
 * nominal target/cap than either month chasing it in isolation would.
 * `existingAssignments` (this month's own assignments, before regenerating) contributes its
 * `fixed` entries - shifts manually locked in (typed as e.g. "8!" in the schedule table) - which
 * survive regeneration untouched instead of being wiped along with everything else; the rest of
 * this month is then built to fit around them. */
export function generateSchedule(
  year: number,
  month: number,
  employees: Employee[],
  unavailability: UnavailabilityMap = {},
  options: ScheduleOptions = {},
  previousAssignments: Assignment[] = [],
  existingAssignments: Assignment[] = [],
): Assignment[] {
  const assignments: Assignment[] = [];
  const fulltime = employees.filter((e) => e.type === 'fulltime');
  const parttime = employees.filter((e) => e.type === 'parttime');
  const totalDays = daysInMonth(year, month);
  const monthIndex = year * 12 + month;

  // Fixed assignments are seeded first and never touched again - every phase below treats their
  // date/employee/kind as already spoken for and folds their hours into the relevant
  // fairness/target bookkeeping, so the rest of the month is built to fit around them.
  const fixedAssignments = existingAssignments.filter((a) => a.shift.fixed);
  assignments.push(...fixedAssignments);

  const fixedDatesByEmployee = new Map<string, Set<string>>();
  employees.forEach((e) => fixedDatesByEmployee.set(e.id, new Set()));
  fixedAssignments.forEach((a) => fixedDatesByEmployee.get(a.employeeId)?.add(a.date));

  // Only weekday (morning/afternoon) fixed hours need to reduce the fulltime week-target math
  // below - fixed weekend hours already flow through `weekendHoursByEmployee` (computed straight
  // off `assignments`, which already contains the fixed ones by the time that runs).
  const fixedWeekdayHoursByEmployee = new Map<string, number>();
  fixedAssignments.forEach((a) => {
    if (a.shift.kind !== 'morning' && a.shift.kind !== 'afternoon') return;
    fixedWeekdayHoursByEmployee.set(a.employeeId, (fixedWeekdayHoursByEmployee.get(a.employeeId) ?? 0) + a.shift.hours);
  });

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

  // Days the business is closed outright (Christmas Eve, New Year's Eve) - unlike a regular
  // holiday, nobody gets any shift here at all, not even a skeleton crew, whatever day of the
  // week they land on.
  const closedDays = getClosedDays(year);

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

  // How many afternoon shifts this employee has so far this month - re-read fresh from the real
  // assignments each time (not a running tally) so it's always accurate regardless of which order
  // the various phases below run in or how many times a shift gets reassigned.
  function afternoonCountSoFar(employeeId: string): number {
    return assignments.filter((a) => a.employeeId === employeeId && a.shift.kind === 'afternoon').length;
  }

  // A simple "about one afternoon a week" pace, used only as a solo tie-breaker (see
  // afternoonCountSoFar) for whether *this* person specifically is due for an afternoon shift -
  // when there's a direct choice between two people instead, comparing their afternoonCountSoFar
  // directly already picks whoever has fewer, and does so correctly regardless of what any
  // absolute pace target says (the target cancels out of that comparison).
  function afternoonPaceTarget(iso: string): number {
    return Number(iso.split('-')[2]) / 7;
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
    if (holidays.has(toISODate(d)) || closedDays.has(toISODate(d))) continue;
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
      const sunday = new Date(year, month, day + 1);
      // If either day of the pair is a closed day, the whole weekend is skipped rather than
      // trying to cover just one half of it - a closed Saturday realistically means a closed
      // Sunday too.
      if (closedDays.has(toISODate(d)) || closedDays.has(toISODate(sunday))) continue;
      weekendPairs.push({ saturday: d, sunday });
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

    const weekendCredits = new Map<string, number>();
    employees.forEach((e) => weekendCredits.set(e.id, 0));

    function assignPair(pairIdx: number, emp: Employee): void {
      const weekKey = toISODate(mondayOf(weekendPairs[pairIdx].saturday));
      // A fixed pair may already have one (or both) of its two days seeded from
      // `fixedAssignments` - only add whichever day isn't already there instead of duplicating it.
      if (!assignments.some((a) => a.employeeId === emp.id && a.date === satIsos[pairIdx] && a.shift.kind === 'weekend')) {
        assignments.push({ date: satIsos[pairIdx], employeeId: emp.id, shift: WEEKEND_SHIFT });
      }
      if (!assignments.some((a) => a.employeeId === emp.id && a.date === sunIsos[pairIdx] && a.shift.kind === 'weekend')) {
        assignments.push({ date: sunIsos[pairIdx], employeeId: emp.id, shift: WEEKEND_SHIFT });
      }
      if (!weekendEmployeeByWeekKey.has(weekKey)) weekendEmployeeByWeekKey.set(weekKey, new Set());
      weekendEmployeeByWeekKey.get(weekKey)!.add(emp.id);
      weekendCredits.set(emp.id, weekendCredits.get(emp.id)! + 1);
    }

    // A pair with either day fixed by hand is settled immediately and removed from the matching
    // pool below - the matching only needs to worry about pairs that are actually still open.
    const fixedPairIndexes = new Set<number>();
    const fixedWeekendEmployeeIds = new Set<string>();
    weekendPairs.forEach((_, idx) => {
      const fixedHere = fixedAssignments.find(
        (a) => a.shift.kind === 'weekend' && (a.date === satIsos[idx] || a.date === sunIsos[idx]),
      );
      if (!fixedHere) return;
      const emp = employees.find((e) => e.id === fixedHere.employeeId);
      if (!emp) return;
      fixedPairIndexes.add(idx);
      fixedWeekendEmployeeIds.add(emp.id);
      assignPair(idx, emp);
    });
    const openPairIndexes = weekendPairs.map((_, idx) => idx).filter((idx) => !fixedPairIndexes.has(idx));

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
      // Someone with an already-fixed weekend elsewhere this month isn't a candidate for a
      // *different* pair too - they're already spoken for, and piling a second one on them while
      // someone else might still need their turn would undercut the whole rotation.
      !fixedWeekendEmployeeIds.has(employees[empIdx].id) &&
      !isUnavailable(employees[empIdx].id, satIsos[pairIdx]) &&
      !isUnavailable(employees[empIdx].id, sunIsos[pairIdx]);

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

    for (const pairIdx of openPairIndexes) {
      tryAugment(pairIdx, new Array(n).fill(false));
    }

    for (const pairIdx of openPairIndexes) {
      if (matchEmployeeOfPair[pairIdx] !== -1) assignPair(pairIdx, employees[matchEmployeeOfPair[pairIdx]]);
    }

    // Any pair the matching couldn't cover (genuine overflow, or nobody free either day) falls
    // back to whoever currently has the fewest weekend turns credited so far.
    for (const pairIdx of openPairIndexes) {
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

  // The calendar week right after this employee's own short (weekend) week - now that they work
  // straight through Friday into the weekend, this is the only place a real break can still land
  // before the following week would otherwise run right on into it.
  function isPostWeekendRecoveryWeek(employeeId: string, weekKey: string): boolean {
    const weekIndex = orderedWeekKeys.indexOf(weekKey);
    if (weekIndex <= 0) return false;
    return isShortWeek(employeeId, orderedWeekKeys[weekIndex - 1]);
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
    if (closedDays.has(iso)) continue; // closed outright - not even a skeleton crew

    // Someone already fixed this holiday by hand - it's already in `assignments` from the seed,
    // just needs crediting so fairness for the rest of the year's holidays stays accurate.
    const fixedHere = fixedAssignments.find((a) => a.date === iso && a.shift.kind === 'holiday');
    if (fixedHere) {
      holidayCredits.set(fixedHere.employeeId, (holidayCredits.get(fixedHere.employeeId) ?? 0) + 1);
      continue;
    }

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
    const fixedHours = fixedWeekdayHoursByEmployee.get(empId) ?? 0;
    const idealTotalDays = Math.max(0, targetHours - weekendHours - fixedHours) / shiftHours;
    const totalTargetDays = Math.round(idealTotalDays);

    // A day already fixed by hand isn't available for the trim-to-target logic below to trade
    // away - it's guaranteed regardless, so it comes out of both the week's capacity and its
    // available-day count up front.
    const fixedDates = fixedDatesByEmployee.get(empId) ?? new Set<string>();
    const capacity = new Map<string, number>();
    orderedWeekKeys.forEach((wk) => {
      const weekdays = weekdaysByWeekKey.get(wk)!;
      const fixedThisWeek = weekdays.filter((d) => fixedDates.has(toISODate(d))).length;
      const availableCount = weekdays.filter(
        (d) => !isUnavailable(empId, toISODate(d)) && !fixedDates.has(toISODate(d)),
      ).length;
      const cap = Math.min(5 - fixedThisWeek, availableCount);
      const reduction = isShortWeek(empId, wk)
        ? shortWeekReduction
        : isPostWeekendRecoveryWeek(empId, wk)
          ? FT_POST_WEEKEND_RECOVERY_DAYS
          : 0;
      capacity.set(wk, Math.max(0, cap - reduction));
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
      const fixedDates = fixedDatesByEmployee.get(emp.id) ?? new Set<string>();
      const available = weekdays.filter((d) => !isUnavailable(emp.id, toISODate(d)) && !fixedDates.has(toISODate(d)));
      const target = ftWeekTargets.get(emp.id)!.get(weekKey) ?? 0;
      const offCount = Math.max(0, available.length - target);
      // The week this employee covers the weekend right after it always trims from the Monday
      // side instead of their usual alternating preference, so Friday itself stays a working day
      // for them - see the Friday-afternoon preference in the day-by-day split below, which
      // depends on them actually being there that day. They still get a real break, it just lands
      // at the start of the week instead of right before the weekend. The week right after that
      // one also trims from the Monday side (see FT_POST_WEEKEND_RECOVERY_DAYS) so the break
      // lands right after the weekend instead of nowhere at all, now that Friday-Saturday-Sunday
      // runs straight into the following week otherwise. Any other week keeps the even/odd
      // alternation, which is what keeps two fulltimers' days off from ever coinciding.
      const trimFromEnd =
        isShortWeek(emp.id, weekKey) || isPostWeekendRecoveryWeek(emp.id, weekKey) ? false : empIndex % 2 === 0;
      const kept =
        offCount === 0
          ? available
          : trimFromEnd
            ? available.slice(0, available.length - offCount)
            : available.slice(offCount);
      const set = ftWorkingDates.get(emp.id)!;
      kept.forEach((d) => set.add(toISODate(d)));
      // A fixed day is guaranteed regardless of what the trim above decided - it was already
      // excluded from `available` so it can't have been trimmed away, this just adds it in.
      weekdays.forEach((d) => {
        if (fixedDates.has(toISODate(d))) set.add(toISODate(d));
      });
    });
  });

  // Safety net: the opposite-end trimming only avoids both being off the same day when both
  // start from the same full week. Personal unavailability can still knock both out on one
  // date - if that happens and at least one of them is actually free that day, pull them back
  // in rather than leaving the day to part-time alone (part-time morning ends at 13:00 and
  // afternoon doesn't start until 16:00, so a fulltime-free day leaves a real gap in between).
  // Skipped for a week where someone's short/recovery week deliberately reduced their days,
  // though - that's the one case both being off the same day is expected, not a coincidence to
  // patch, and patching it would silently re-add the very day the reduction was trying to
  // remove, pushing hours right back past the monthly target it was computed against.
  if (fulltime.length >= 2) {
    orderedWeekKeys.forEach((weekKey) => {
      const deliberateRestThisWeek = fulltime.some(
        (emp) => isShortWeek(emp.id, weekKey) || isPostWeekendRecoveryWeek(emp.id, weekKey),
      );
      if (deliberateRestThisWeek) return;
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
      // Whoever covers the weekend right after this week ideally takes Friday afternoon too,
      // leading straight into it - only meaningful on an actual Friday.
      const isFriday = d.getDay() === 5;

      // Whoever this employee's own fixed kind is today, if any - `.find` rather than tracking
      // every kind is deliberate: fixing both a morning and afternoon for the same person the
      // same day isn't a pattern this supports specially, though nothing here corrupts data if
      // it happens (both stay seeded in `assignments` either way).
      const fixedKindFor = (empId: string): 'morning' | 'afternoon' | null => {
        const fixed = fixedAssignments.find(
          (a) => a.employeeId === empId && a.date === iso && (a.shift.kind === 'morning' || a.shift.kind === 'afternoon'),
        );
        return fixed ? (fixed.shift.kind as 'morning' | 'afternoon') : null;
      };
      // Afternoon only ever has one person on duty (same rule part-time's own gap-filling
      // respects) - if anyone (fulltime or part-time) already has a fixed afternoon today,
      // afternoon is off the table for everyone else, fulltime included.
      const fixedAfternoonOwner = fixedAssignments.find((a) => a.date === iso && a.shift.kind === 'afternoon')?.employeeId;
      const canWork = (emp: Employee, kind: 'morning' | 'afternoon') => {
        if (isUnavailableForKind(emp.id, iso, kind)) return false;
        if (kind === 'afternoon' && fixedAfternoonOwner && fixedAfternoonOwner !== emp.id) return false;
        return true;
      };

      if (working.length >= 2) {
        const [first, second] = working;
        const firstFixedKind = fixedKindFor(first.id);
        const secondFixedKind = fixedKindFor(second.id);

        if (firstFixedKind || secondFixedKind) {
          // At least one of today's two fulltimers is locked in already (and already seeded into
          // `assignments`) - respect it exactly and just decide whoever's left, instead of
          // re-deciding the day from scratch.
          if (firstFixedKind && secondFixedKind) {
            ftTakenSlots.add(`${iso}-${firstFixedKind}`);
            ftTakenSlots.add(`${iso}-${secondFixedKind}`);
            if (firstFixedKind === secondFixedKind) {
              gaps.push({ date: iso, kind: firstFixedKind === 'morning' ? 'afternoon' : 'morning' });
            }
          } else {
            const lockedEmp = firstFixedKind ? first : second;
            const lockedKind = (firstFixedKind ?? secondFixedKind)!;
            const otherEmp = lockedEmp === first ? second : first;
            const remainingKind: 'morning' | 'afternoon' = lockedKind === 'morning' ? 'afternoon' : 'morning';
            ftTakenSlots.add(`${iso}-${lockedKind}`);
            if (canWork(otherEmp, remainingKind)) {
              assignments.push({ date: iso, employeeId: otherEmp.id, shift: SHIFTS.fulltime[remainingKind] });
              ftTakenSlots.add(`${iso}-${remainingKind}`);
            } else {
              gaps.push({ date: iso, kind: remainingKind });
            }
          }
          ftFlipCounter++;
          return;
        }

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
          // Either split works. On a Friday, whoever covers the weekend right after it takes
          // priority for the afternoon - that's the one case this overrides the usual fairness
          // tiebreak below, since leading straight into the weekend matters more than keeping the
          // afternoon count perfectly even. Otherwise, give the afternoon to whoever currently has
          // fewer of them, so afternoons stay balanced between the two instead of drifting toward
          // whichever side the flip counter happens to favor over a run of similar days. Ties
          // (most likely early in the month, before either has any afternoons yet) fall back to
          // the flip counter for variety.
          const firstHasWeekend = isFriday && isShortWeek(first.id, weekKey);
          const secondHasWeekend = isFriday && isShortWeek(second.id, weekKey);
          const firstAfternoons = afternoonCountSoFar(first.id);
          const secondAfternoons = afternoonCountSoFar(second.id);
          const afternoonEmp = firstHasWeekend
            ? first
            : secondHasWeekend
              ? second
              : firstAfternoons !== secondAfternoons
                ? firstAfternoons < secondAfternoons
                  ? first
                  : second
                : ftFlipCounter % 2 === 0
                  ? first
                  : second;
          const morningEmp = afternoonEmp === first ? second : first;
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
        } else if (firstM || firstA || secondM || secondA) {
          // Both are restricted to the same single kind this day (rare) - only one of them can
          // actually be used, so fall back to treating it like a lone worker.
          const solo = firstM || firstA ? first : second;
          const soloKind: 'morning' | 'afternoon' = canWork(solo, 'morning') ? 'morning' : 'afternoon';
          const gapKind = soloKind === 'morning' ? 'afternoon' : 'morning';
          assignments.push({ date: iso, employeeId: solo.id, shift: SHIFTS.fulltime[soloKind] });
          ftTakenSlots.add(`${iso}-${soloKind}`);
          gaps.push({ date: iso, kind: gapKind });
        } else {
          // Neither can work either kind (e.g. both blocked from the only open kind by someone
          // else's fixed afternoon) - the day is a genuine gap on both sides.
          gaps.push({ date: iso, kind: 'morning' });
          gaps.push({ date: iso, kind: 'afternoon' });
        }
        ftFlipCounter++;
      } else if (working.length === 1) {
        const emp = working[0];
        const fixedKind = fixedKindFor(emp.id);
        if (fixedKind) {
          // Already locked in and already in `assignments` from the seed - just record the
          // complementary gap for part-time, same as the normal solo-worker path does.
          ftTakenSlots.add(`${iso}-${fixedKind}`);
          gaps.push({ date: iso, kind: fixedKind === 'morning' ? 'afternoon' : 'morning' });
          ftFlipCounter++;
          return;
        }
        const canMorning = canWork(emp, 'morning');
        const canAfternoon = canWork(emp, 'afternoon');
        // No second fulltimer today to compare against directly, so fall back to the simple
        // "about one afternoon a week" pace to decide if this specific person is due for one -
        // unless it's their own Friday leading into a weekend they cover, which wins outright.
        const hasWeekendThisWeek = isFriday && isShortWeek(emp.id, weekKey);
        const dueForAfternoon = hasWeekendThisWeek || afternoonCountSoFar(emp.id) < afternoonPaceTarget(iso);
        const kind: 'morning' | 'afternoon' | null =
          canMorning && canAfternoon ? (dueForAfternoon ? 'afternoon' : 'morning') : canMorning ? 'morning' : canAfternoon ? 'afternoon' : null;
        if (kind) {
          const gapKind = kind === 'morning' ? 'afternoon' : 'morning';
          assignments.push({ date: iso, employeeId: emp.id, shift: SHIFTS.fulltime[kind] });
          ftTakenSlots.add(`${iso}-${kind}`);
          gaps.push({ date: iso, kind: gapKind });
        } else {
          // Blocked from the only kind still open (someone else's fixed afternoon) - genuine gap.
          gaps.push({ date: iso, kind: 'morning' });
          gaps.push({ date: iso, kind: 'afternoon' });
        }
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

  // Seed both from whatever's already fixed, so nothing below double-books a slot or day a fixed
  // part-time shift already covers.
  fixedAssignments.forEach((a) => {
    if (!ptDatesWorked.has(a.employeeId)) return;
    if (a.shift.kind === 'morning' || a.shift.kind === 'afternoon') ptTakenSlots.add(`${a.date}-${a.shift.kind}`);
    ptDatesWorked.get(a.employeeId)!.add(a.date);
  });

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
    // Among whoever can actually take it, prefer someone it wouldn't run into a long streak for -
    // this is still choosing among people who satisfy every real rule above, so covering the gap
    // itself is never in question, only who ends up covering it. Falls back to the normal
    // fewest-hours-so-far fairness tie-break, both among streak-safe candidates and (if nobody
    // is streak-safe) among everyone eligible.
    const dayOfMonth = Number(date.split('-')[2]);
    const chosen = eligible.sort((a, b) => {
      const aExtends = wouldExtendStreakTooFar(a.id, dayOfMonth) ? 1 : 0;
      const bExtends = wouldExtendStreakTooFar(b.id, dayOfMonth) ? 1 : 0;
      if (aExtends !== bExtends) return aExtends - bExtends;
      return (ptHours.get(a.id) ?? 0) - (ptHours.get(b.id) ?? 0);
    })[0];
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
    parttime.forEach((emp) => {
      // Every day this employee's role allows them to work this month, in date order.
      const roleDays: Date[] = [];
      orderedWeekKeys.forEach((weekKey) => {
        const isLight = ptRoleIsLight(emp.id, weekKey);
        const allowedWeekdays = isLight ? PT_LIGHT_WEEKDAYS : PT_HEAVY_WEEKDAYS;
        weekdaysByWeekKey.get(weekKey)!.forEach((d) => {
          const dow = (d.getDay() + 6) % 7; // Monday = 0
          if (!allowedWeekdays.has(dow)) return;
          if (ptDatesWorked.get(emp.id)!.has(toISODate(d))) return; // already covered (e.g. a fixed shift)
          roleDays.push(d);
        });
      });
      if (roleDays.length === 0) return;

      // Aim for full 8h days first - like standing in for fulltime for the day - and use at most
      // one shorter 4h day to mop up whatever's left, instead of defaulting every role day to 4h
      // and upgrading some later: fewer, longer support shifts for the same monthly total, and a
      // similar count of each between the two part-timers since both work from the same target.
      const budget = Math.max(0, effectivePtCap(emp.id) - (ptHours.get(emp.id) ?? 0));
      const eightCount = Math.min(roleDays.length, Math.floor(budget / SHIFTS.fulltime.morning.hours));
      const remainder = budget - eightCount * SHIFTS.fulltime.morning.hours;
      const fourCount = eightCount < roleDays.length && remainder >= SHIFTS.parttime.morning.hours ? 1 : 0;
      const workedCount = eightCount + fourCount;
      if (workedCount === 0) return;

      // Which role-eligible days actually get worked is spread evenly across the month (same
      // idea as evenlySpacedIndices elsewhere), not just the earliest ones, so a lighter budget
      // doesn't front-load all the work into the first couple of weeks and leave the rest empty.
      const workedPositions = [...evenlySpacedIndices(roleDays.length, workedCount)].sort((a, b) => a - b);

      workedPositions.forEach((pos, i) => {
        const iso = toISODate(roleDays[pos]);
        // Since nobody can take a second shift the same day, this is the role-eligible
        // part-timer's only chance to cover that date - so pick whichever kind fulltime actually
        // left as a gap (when there's exactly one), instead of always defaulting to morning.
        // Otherwise a person shows up for a support morning shift while the real gap (the
        // afternoon) goes completely uncovered, purely because of which kind was decided first.
        // Failing that, if this person is overdue for an afternoon (about one a week is the
        // target) and the afternoon slot happens to be free, take it proactively instead of
        // defaulting to morning - otherwise long/short week's own default would leave part-timers
        // with almost no afternoons at all. Only defaults to morning once neither of those apply,
        // which is also the more useful shape (two people in the morning, one in the afternoon)
        // on an otherwise fully-covered day.
        const gapKindsThisDate = new Set(gaps.filter((g) => g.date === iso).map((g) => g.kind));
        const afternoonIsGap = gapKindsThisDate.has('afternoon') && !gapKindsThisDate.has('morning');
        const afternoonFree = !ftTakenSlots.has(`${iso}-afternoon`) && !ptTakenSlots.has(`${iso}-afternoon`);
        const dueForAfternoon = afternoonCountSoFar(emp.id) < afternoonPaceTarget(iso);
        const kind: 'morning' | 'afternoon' =
          afternoonIsGap || (afternoonFree && dueForAfternoon) ? 'afternoon' : 'morning';
        if (ptTakenSlots.has(`${iso}-${kind}`)) return;
        if (isUnavailableForKind(emp.id, iso, kind)) return;
        const shift = i < eightCount ? SHIFTS.fulltime[kind] : SHIFTS.parttime[kind];
        if ((ptHours.get(emp.id) ?? 0) + shift.hours > effectivePtCap(emp.id)) return;
        assignments.push({ date: iso, employeeId: emp.id, shift });
        ptTakenSlots.add(`${iso}-${kind}`);
        ptHours.set(emp.id, (ptHours.get(emp.id) ?? 0) + shift.hours);
        ptDatesWorked.get(emp.id)!.add(iso);
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
  // Whether giving `employeeId` a worked day on day-of-month `day` (any kind - re-read fresh from
  // the real assignments so far, not a running tally that could drift) would push their run of
  // consecutive worked days past the soft streak target. Only meant for guarding *discretionary*
  // extra shifts like the top-up below, never a real gap - covering an actual need matters more
  // than this, but topping up a part-timer's hours a bit further than the cap already requires is
  // exactly the kind of "not actually necessary" day this should decline to add.
  function wouldExtendStreakTooFar(employeeId: string, day: number): boolean {
    const workedDays = new Set(
      assignments.filter((a) => a.employeeId === employeeId).map((a) => Number(a.date.split('-')[2])),
    );
    workedDays.add(day);
    let start = day;
    while (start > 1 && workedDays.has(start - 1)) start--;
    let end = day;
    while (end < totalDays && workedDays.has(end + 1)) end++;
    return end - start + 1 > MAX_CONSECUTIVE_SHIFTS;
  }

  if (parttime.length > 0 && !ptLongShortWeek) {
    const allWeekdays: Date[] = [];
    orderedWeekKeys.forEach((wk) => allWeekdays.push(...weekdaysByWeekKey.get(wk)!));
    const shiftHours = SHIFTS.parttime.morning.hours; // same for morning and afternoon

    parttime.forEach((emp) => {
      const cap = effectivePtCap(emp.id);
      for (const day of allWeekdays) {
        if ((ptHours.get(emp.id) ?? 0) + shiftHours > cap) break;
        const iso = toISODate(day);
        if (ptDatesWorked.get(emp.id)!.has(iso)) continue;
        // Default support shift is morning (fulltime is typically already there too - that
        // overlap is fine), but if this person is overdue for an afternoon - or it's their own
        // Friday leading into a weekend they cover - and the afternoon slot is actually free, take
        // that instead. Otherwise a part-timer's afternoons stay near zero forever, since
        // gap-filling is the only other place they'd ever get one.
        const afternoonFree = !ftTakenSlots.has(`${iso}-afternoon`) && !ptTakenSlots.has(`${iso}-afternoon`);
        const hasWeekendThisWeek = day.getDay() === 5 && isShortWeek(emp.id, toISODate(mondayOf(day)));
        const dueForAfternoon = hasWeekendThisWeek || afternoonCountSoFar(emp.id) < afternoonPaceTarget(iso);
        const kind: 'morning' | 'afternoon' = afternoonFree && dueForAfternoon ? 'afternoon' : 'morning';
        if (isUnavailableForKind(emp.id, iso, kind)) continue;
        if (wouldExtendStreakTooFar(emp.id, day.getDate())) continue;
        assignments.push({ date: iso, employeeId: emp.id, shift: SHIFTS.parttime[kind] });
        if (kind === 'afternoon') ptTakenSlots.add(`${iso}-afternoon`);
        ptHours.set(emp.id, (ptHours.get(emp.id) ?? 0) + shiftHours);
        ptDatesWorked.get(emp.id)!.add(iso);
      }
    });
  }

  // Picks `count` positions out of `0..total-1`, spread as evenly as possible (e.g. total=9,
  // count=4 -> {1,3,5,7}) rather than just the first `count` - used below so a part-timer's
  // upgraded-to-8h shifts land spread across their whole month instead of bunched at its start.
  function evenlySpacedIndices(total: number, count: number): Set<number> {
    const selected = new Set<number>();
    if (count <= 0 || total <= 0) return selected;
    if (count >= total) {
      for (let i = 0; i < total; i++) selected.add(i);
      return selected;
    }
    for (let i = 0; i < count; i++) {
      selected.add(Math.floor(((i + 0.5) * total) / count));
    }
    return selected;
  }

  // "Long/short week" catch-up: each part-timer's own already-scheduled weekday days get
  // upgraded in place from the standard 4h shift to the 8h SHIFTS.fulltime version (same shift
  // fulltime uses, break included, since it's the same >6h shift no matter who works it) instead
  // of adding new days, until they approach their own cap - independently of one another, not
  // relative to whichever partner happens to be ahead. The alternating heavy/light roles already
  // give the two part-timers the same number of days in a typical month, so this equalizes them
  // as a side effect; but it must target each person's own cap directly, since two people with
  // identical day counts would otherwise both already "be at the max" relative to each other and
  // neither would ever get upgraded, even miles under the real 80h cap. Which days get the 8h
  // upgrade is spread evenly across the month (see evenlySpacedIndices) rather than always the
  // earliest ones - a heavy first half and light second half isn't the point of the alternating
  // heavy/light week pattern this mode is named after; a mix spread throughout it is.
  if (parttime.length > 0 && ptLongShortWeek) {
    const perUpgradeHours = SHIFTS.fulltime.morning.hours - SHIFTS.parttime.morning.hours;
    parttime.forEach((emp) => {
      const target = effectivePtCap(emp.id);
      const baseline = ptHours.get(emp.id) ?? 0;
      if (baseline >= target || perUpgradeHours <= 0) return;
      const ownShiftIndexes = assignments
        .map((_, idx) => idx)
        .filter((idx) => {
          const a = assignments[idx];
          // A fixed shift's hours are exactly what was manually locked in - upgrading it here
          // would silently override that.
          return a.employeeId === emp.id && (a.shift.kind === 'morning' || a.shift.kind === 'afternoon') && !a.shift.fixed;
        })
        .sort((i1, i2) => assignments[i1].date.localeCompare(assignments[i2].date));

      const upgradeCount = Math.min(ownShiftIndexes.length, Math.floor((target - baseline) / perUpgradeHours));
      const upgradePositions = evenlySpacedIndices(ownShiftIndexes.length, upgradeCount);
      upgradePositions.forEach((pos) => {
        const idx = ownShiftIndexes[pos];
        const current = assignments[idx];
        const kind = current.shift.kind as 'morning' | 'afternoon';
        const longShift = SHIFTS.fulltime[kind];
        if (current.shift.hours >= longShift.hours) return; // already the long version
        const added = longShift.hours - current.shift.hours;
        assignments[idx] = { ...current, shift: longShift };
        ptHours.set(emp.id, (ptHours.get(emp.id) ?? 0) + added);
      });
    });
  }

  // --- Soft pass: nudge away from long stretches of consecutive worked days (any shift kind
  //     counts, including weekend/holiday). Deliberately the very last thing this function does
  //     and deliberately soft - it only ever hands a single weekday shift to a same-type coworker,
  //     and only when that coworker is free that day, actually available for it, within their own
  //     monthly cap/tolerance, respects their "long/short week" role if that mode is on, and
  //     wouldn't just end up with a long streak of their own from taking it. If no such coworker
  //     exists anywhere in the run, the streak is left alone - every rule already applied above
  //     matters more than this one. Weekend pairs and the single holiday shift are never moved
  //     (only a morning/afternoon weekday assignment can be the one that's handed off): an
  //     always-together weekend and a fairness-tracked once-a-month holiday turn are both rules
  //     that matter more than smoothing out a streak. Only looks within this calendar month - there
  //     is no record here of exactly which of last month's final days someone worked, so a streak
  //     that started before day 1 can't be detected or fixed. ---
  softenConsecutiveStreaks();

  function softenConsecutiveStreaks(): void {
    if (employees.length < 2) return;

    function buildWorkedDays(): Map<string, boolean[]> {
      const worked = new Map<string, boolean[]>();
      employees.forEach((e) => worked.set(e.id, new Array(totalDays + 1).fill(false)));
      assignments.forEach((a) => {
        const days = worked.get(a.employeeId);
        if (days) days[Number(a.date.split('-')[2])] = true;
      });
      return worked;
    }

    function runBounds(days: boolean[], day: number): [number, number] {
      let start = day;
      while (start > 1 && days[start - 1]) start--;
      let end = day;
      while (end < totalDays && days[end + 1]) end++;
      return [start, end];
    }

    function longestRun(days: boolean[]): [number, number] | null {
      let best: [number, number] | null = null;
      let day = 1;
      while (day <= totalDays) {
        if (!days[day]) {
          day++;
          continue;
        }
        const [start, end] = runBounds(days, day);
        if (!best || end - start > best[1] - best[0]) best = [start, end];
        day = end + 1;
      }
      return best;
    }

    function employeeHours(empId: string): number {
      return assignments.filter((a) => a.employeeId === empId).reduce((sum, a) => sum + a.shift.hours, 0);
    }

    // Tries to move `emp`'s weekday shift on `day` to whichever eligible coworker in `candidates`
    // is checked first (same-type coworkers first, a cross-type one only as a last resort - see
    // the caller) - returns whether a coworker was actually found and the swap made. With
    // `enforceCap` off, a candidate's own hour target/cap no longer rules them out - see the
    // caller for when that's used.
    function trySwapDay(
      emp: Employee,
      day: number,
      candidates: Employee[],
      worked: Map<string, boolean[]>,
      enforceCap: boolean,
    ): boolean {
      const iso = toISODate(new Date(year, month, day));
      const index = assignments.findIndex(
        (a) => a.employeeId === emp.id && a.date === iso && (a.shift.kind === 'morning' || a.shift.kind === 'afternoon'),
      );
      // A fixed shift was manually locked in on purpose - never hand it to someone else just to
      // smooth out a streak, that's the lowest-priority rule in this whole function.
      if (index === -1 || assignments[index].shift.fixed) return false;
      const kind = assignments[index].shift.kind as 'morning' | 'afternoon';

      for (const candidate of candidates) {
        const candidateDays = worked.get(candidate.id)!;
        if (candidateDays[day]) continue; // already working that date
        if (isUnavailableForKind(candidate.id, iso, kind)) continue;
        if (candidate.type === 'parttime' && !ptRoleAllowsDay(candidate.id, iso)) continue;

        // Keep whatever coverage was already there, regardless of who ends up covering it: a
        // fulltime day handed to a part-timer stays a full 8h (they stand in for fulltime that
        // day, same idea as long/short week's own 8h days), and a part-time day handed to a
        // fulltime candidate stays at its original 4h instead of over-provisioning a day that
        // never needed a full fulltime shift to begin with.
        const newShift = SHIFTS[emp.type][kind];
        if (enforceCap) {
          const projected = employeeHours(candidate.id) + newShift.hours;
          if (candidate.type === 'parttime' && projected > effectivePtCap(candidate.id)) continue;
          if (candidate.type === 'fulltime' && projected > effectiveFulltimeTarget(candidate.id) + FULLTIME_HOURS_TOLERANCE) continue;
        }

        // Don't just hand the streak to someone who'd immediately have one of their own - this
        // still applies even as a last resort, since trading one excessive streak for another
        // isn't actually a fix.
        candidateDays[day] = true;
        const [cStart, cEnd] = runBounds(candidateDays, day);
        candidateDays[day] = false;
        if (cEnd - cStart + 1 > MAX_CONSECUTIVE_SHIFTS) continue;

        assignments[index] = { date: iso, employeeId: candidate.id, shift: newShift };
        return true;
      }
      return false;
    }

    employees.forEach((emp) => {
      const sameType = employees.filter((e) => e.id !== emp.id && e.type === emp.type);
      const otherType = employees.filter((e) => e.id !== emp.id && e.type !== emp.type);
      // A same-type coworker is the natural, preferred fix; a cross-type one (a part-timer
      // standing in for a fulltime day, or vice versa) is only tried once every same-type option
      // for that specific day is exhausted, since it's a bigger ask of their own schedule.
      const candidates = [...sameType, ...otherType];
      if (candidates.length === 0) return;

      // Each successful swap only ever shortens this employee's runs, never lengthens one, so a
      // bounded number of passes is enough - one swap per remaining over-threshold run, worst case.
      for (let guard = 0; guard < totalDays; guard++) {
        const worked = buildWorkedDays();
        const run = longestRun(worked.get(emp.id)!);
        if (!run || run[1] - run[0] + 1 <= MAX_CONSECUTIVE_SHIFTS) break;
        const [start, end] = run;
        const middle = Math.floor((start + end) / 2);

        // Try days outward from the middle, so a successful fix roughly bisects the run into two
        // shorter pieces instead of just shaving one end of it.
        function trySwapAnyDay(enforceCap: boolean): boolean {
          for (let offset = 0; offset <= end - start; offset++) {
            const candidateDays = offset === 0 ? [middle] : [middle - offset, middle + offset];
            for (const day of candidateDays) {
              if (day < start || day > end) continue;
              if (trySwapDay(emp, day, candidates, worked, enforceCap)) return true;
            }
          }
          return false;
        }
        // First choice respects everyone's own hour target/cap; if that leaves nobody able to
        // take any day in the run (a small team can easily have everyone already near their own
        // limit), an excessive streak is worse than someone quietly landing a bit over their
        // target for one day - which still surfaces as its usual hours warning, so it stays
        // visible and easy to correct by hand.
        const fixed = trySwapAnyDay(true) || trySwapAnyDay(false);
        if (!fixed) break; // nobody in the team could take any day in this run - leave it as-is
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
  const closedDays = getClosedDays(year);

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
    // The business is closed outright this day (Christmas Eve, New Year's Eve) - nothing is
    // ever expected to be covered, so there's nothing missing to flag.
    if (closedDays.has(iso)) continue;
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
