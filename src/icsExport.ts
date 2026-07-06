import type { Assignment, Employee } from './types';

const SHIFT_LABELS: Record<string, string> = {
  morning: 'Ranní',
  afternoon: 'Odpolední',
  weekend: 'Víkendová',
  holiday: 'Sváteční',
};

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Local "floating time" (no Z/offset) - simplest option for a team that's all in one
 * timezone, and avoids needing to embed a VTIMEZONE definition. */
function toIcsDateTime(date: string, time: string): string {
  const [y, m, d] = date.split('-');
  const [h, min] = time.split(':');
  return `${y}${m}${d}T${h}${min}00`;
}

function nowAsIcsUtcStamp(): string {
  const now = new Date();
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-');
}

/** Generates and downloads an .ics calendar file for the given month's schedule, optionally
 * filtered to a single employee - meant for subscribing/importing just your own shifts into a
 * personal phone calendar rather than the whole team's. */
export function exportScheduleToIcs(
  year: number,
  month: number,
  employees: Employee[],
  assignments: Assignment[],
  employeeId: string | null,
): void {
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const filtered = employeeId ? assignments.filter((a) => a.employeeId === employeeId) : assignments;
  const stamp = nowAsIcsUtcStamp();

  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Planovac smen//CS', 'CALSCALE:GREGORIAN'];

  filtered.forEach((a, i) => {
    const emp = employeeById.get(a.employeeId);
    const empName = emp?.name ?? '?';
    const kindLabel = SHIFT_LABELS[a.shift.kind] ?? a.shift.kind;
    const summary = employeeId ? `${kindLabel} směna` : `${empName} – ${kindLabel}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${a.date}-${a.employeeId}-${a.shift.kind}-${i}@planovac-smen`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toIcsDateTime(a.date, a.shift.start)}`,
      `DTEND:${toIcsDateTime(a.date, a.shift.end)}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `DESCRIPTION:${escapeIcsText(`${empName}, ${a.shift.hours.toFixed(1)} h`)}`,
      'END:VEVENT',
    );
  });

  lines.push('END:VCALENDAR');

  const content = lines.join('\r\n') + '\r\n';
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const suffix = employeeId ? `-${slugify(employeeById.get(employeeId)?.name ?? 'zamestnanec')}` : '-vsichni';
  link.href = url;
  link.download = `planovac-smen-${year}-${String(month + 1).padStart(2, '0')}${suffix}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
