function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Fixed-date Czech public holidays (month is 1-indexed here for readability). */
const FIXED_HOLIDAYS: { month: number; day: number; name: string }[] = [
  { month: 1, day: 1, name: 'Den obnovy samostatného českého státu' },
  { month: 5, day: 1, name: 'Svátek práce' },
  { month: 5, day: 8, name: 'Den vítězství' },
  { month: 7, day: 5, name: 'Den slovanských věrozvěstů Cyrila a Metoděje' },
  { month: 7, day: 6, name: 'Den upálení mistra Jana Husa' },
  { month: 9, day: 28, name: 'Den české státnosti' },
  { month: 10, day: 28, name: 'Den vzniku samostatného československého státu' },
  { month: 11, day: 17, name: 'Den boje za svobodu a demokracii' },
  { month: 12, day: 24, name: 'Štědrý den' },
  { month: 12, day: 25, name: '1. svátek vánoční' },
  { month: 12, day: 26, name: '2. svátek vánoční' },
];

/** Anonymous Gregorian algorithm (Meeus/Jones/Butcher) for the date of Easter Sunday, which
 * Good Friday and Easter Monday - the only two movable Czech public holidays - are relative to. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/** ISO date -> holiday name, for every Czech public holiday in the given calendar year. */
export function getCzechHolidays(year: number): Map<string, string> {
  const map = new Map<string, string>();
  FIXED_HOLIDAYS.forEach(({ month, day, name }) => {
    map.set(iso(year, month, day), name);
  });

  const easter = easterSunday(year);
  const goodFriday = new Date(easter);
  goodFriday.setDate(easter.getDate() - 2);
  const easterMonday = new Date(easter);
  easterMonday.setDate(easter.getDate() + 1);
  map.set(iso(goodFriday.getFullYear(), goodFriday.getMonth() + 1, goodFriday.getDate()), 'Velký pátek');
  map.set(iso(easterMonday.getFullYear(), easterMonday.getMonth() + 1, easterMonday.getDate()), 'Velikonoční pondělí');

  return map;
}
