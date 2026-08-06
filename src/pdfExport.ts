import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Assignment, Employee, ShiftDefinition } from './types';
import { daysInMonth, toISODate } from './scheduler';
import { getCzechHolidays } from './holidays';

const WEEKDAY_LABELS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
const MONTH_NAMES = [
  'Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec',
];

// The same solid accent blue the on-screen table uses to mark a filled afternoon shift - text on
// top switches to white so it stays readable against the fully saturated fill.
const AFTERNOON_FILL: [number, number, number] = [23, 182, 245];
const AFTERNOON_TEXT: [number, number, number] = [255, 255, 255];
const WEEKEND_FILL: [number, number, number] = [219, 234, 248];
const HOLIDAY_FILL: [number, number, number] = [240, 224, 196];

async function fetchFontBase64(url: string): Promise<string> {
  const buffer = await fetch(url).then((r) => r.arrayBuffer());
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

let fontCache: { regular: string; bold: string } | null = null;

async function ensureCzechFont(doc: jsPDF): Promise<void> {
  if (!fontCache) {
    // jsPDF's own TTF parser doesn't reliably read the cmap of every font (Roboto's, for
    // instance, drops č/ě/ř/ž entirely); DejaVu Sans is the font commonly used to work
    // around that and covers the full Czech alphabet.
    const [regular, bold] = await Promise.all([
      fetchFontBase64(`${import.meta.env.BASE_URL}fonts/DejaVuSans.ttf`),
      fetchFontBase64(`${import.meta.env.BASE_URL}fonts/DejaVuSans-Bold.ttf`),
    ]);
    fontCache = { regular, bold };
  }
  // jsPDF's font table is per-document instance, so every new doc needs the VFS entries
  // registered again even though the underlying base64 data is only fetched once.
  doc.addFileToVFS('DejaVuSans.ttf', fontCache.regular);
  doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'normal');
  doc.addFileToVFS('DejaVuSans-Bold.ttf', fontCache.bold);
  doc.addFont('DejaVuSans-Bold.ttf', 'DejaVuSans', 'bold');
}

interface DayColumn {
  day: number;
  iso: string;
  weekdayLabel: string;
  isWeekend: boolean;
  isHoliday: boolean;
  /** A plain weekday gets its own morning+afternoon slot; weekend/holiday is one whole-day slot.
   * Monday is the same single-slot shape - it never has an afternoon shift at all (see the
   * generator), just a morning one. */
  kinds: ShiftDefinition['kind'][];
}

function buildDayColumns(year: number, month: number): DayColumn[] {
  const holidays = getCzechHolidays(year);
  const totalDays = daysInMonth(year, month);
  const columns: DayColumn[] = [];
  for (let day = 1; day <= totalDays; day++) {
    const date = new Date(year, month, day);
    const iso = toISODate(date);
    const dow = date.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = !isWeekend && holidays.has(iso);
    columns.push({
      day,
      iso,
      weekdayLabel: WEEKDAY_LABELS[(dow + 6) % 7],
      isWeekend,
      isHoliday,
      kinds: isWeekend ? ['weekend'] : isHoliday ? ['holiday'] : dow === 1 ? ['morning'] : ['morning', 'afternoon'],
    });
  }
  return columns;
}

/** Whole hours print as a bare integer ("8"); anything else keeps one decimal ("6,5") - saves
 * space in columns that are only a few millimeters wide. */
function formatHoursCompact(hours: number): string {
  if (Number.isInteger(hours)) return String(hours);
  return hours.toFixed(1).replace('.', ',');
}

interface ColumnMeta {
  isWeekend: boolean;
  isHoliday: boolean;
  isDayStart: boolean;
  kind: ShiftDefinition['kind'];
}

/** Draws one half-month's table (employees x days, R/O split per weekday) starting at `startY`
 * and returns the Y position right after it, so the next half can be stacked below. Splitting
 * the month into two halves - like this is used on paper - roughly halves the number of columns
 * per table, which is what leaves room for a much larger, easily printable font. */
function renderHalfTable(
  doc: jsPDF,
  columns: DayColumn[],
  employees: Employee[],
  hoursByCellKind: Map<string, number>,
  startY: number,
  margin: number,
  pageWidth: number,
  showTotal: boolean,
  totalHoursByEmployee: Map<string, number>,
): number {
  const nameColWidth = 38;
  const totalColWidth = 20;
  const dayColCount = columns.reduce((sum, d) => sum + d.kinds.length, 0);
  const reservedWidth = nameColWidth + (showTotal ? totalColWidth : 0);
  const dayColWidth = (pageWidth - margin * 2 - reservedWidth) / dayColCount;

  const headRow1: (string | { content: string; colSpan?: number; rowSpan?: number })[] = [
    { content: '', rowSpan: 2 },
  ];
  const headRow2: string[] = [];
  columns.forEach((d) => {
    if (d.kinds.length > 1) {
      headRow1.push({ content: `${d.weekdayLabel}\n${d.day}`, colSpan: 2 });
      headRow2.push('R', 'O');
    } else {
      headRow1.push({ content: `${d.weekdayLabel}\n${d.day}`, rowSpan: 2 });
    }
  });
  if (showTotal) headRow1.push({ content: 'Celkem', rowSpan: 2 });

  const body: string[][] = employees.map((emp) => {
    const row: string[] = [emp.name];
    columns.forEach((d) => {
      d.kinds.forEach((kind) => {
        const hours = hoursByCellKind.get(`${d.iso}|${emp.id}|${kind}`) ?? 0;
        row.push(hours > 0 ? formatHoursCompact(hours) : '');
      });
    });
    if (showTotal) row.push(formatHoursCompact(totalHoursByEmployee.get(emp.id) ?? 0));
    return row;
  });

  // Column index (in the flattened body sense, 1-based since column 0 is the employee name) ->
  // which day it belongs to, so weekend/holiday/afternoon cells can get their shading and every
  // day's first sub-column can get a heavier left border - same visual language as on screen.
  const columnMeta: ColumnMeta[] = [];
  columns.forEach((d) => {
    d.kinds.forEach((kind, i) => {
      columnMeta.push({ isWeekend: d.isWeekend, isHoliday: d.isHoliday, isDayStart: i === 0, kind });
    });
  });

  const columnStyles: Record<number, { cellWidth: number; halign?: 'left'; fontStyle?: 'bold' }> = {
    0: { cellWidth: nameColWidth, halign: 'left', fontStyle: 'bold' },
  };
  for (let i = 0; i < dayColCount; i++) columnStyles[i + 1] = { cellWidth: dayColWidth };
  if (showTotal) columnStyles[dayColCount + 1] = { cellWidth: totalColWidth, fontStyle: 'bold' };

  autoTable(doc, {
    startY,
    margin: { left: margin, right: margin },
    head: [headRow1, headRow2],
    body,
    styles: {
      font: 'DejaVuSans',
      fontSize: 10,
      cellPadding: 1.6,
      halign: 'center',
      valign: 'middle',
      lineColor: [170, 170, 170],
      lineWidth: 0.1,
      textColor: 0,
    },
    headStyles: {
      font: 'DejaVuSans',
      fontStyle: 'bold',
      fillColor: [235, 238, 242],
      textColor: 0,
      fontSize: 10,
      cellPadding: 1.6,
      lineColor: [140, 140, 140],
      lineWidth: 0.15,
    },
    bodyStyles: {
      minCellHeight: 8,
    },
    columnStyles,
    theme: 'grid',
    didParseCell: (data) => {
      // Column 0 is the employee name, the (optional) last column is the total - only the day
      // columns in between carry the weekend/holiday/afternoon/day-start treatment.
      const dayIdx = data.column.index - 1;
      const info = columnMeta[dayIdx];
      if (!info) return;
      if (info.isHoliday) data.cell.styles.fillColor = HOLIDAY_FILL;
      else if (info.isWeekend) data.cell.styles.fillColor = WEEKEND_FILL;
      else if (info.kind === 'afternoon' && data.section === 'body' && data.cell.raw) {
        data.cell.styles.fillColor = AFTERNOON_FILL;
        data.cell.styles.textColor = AFTERNOON_TEXT;
      }
      if (info.isDayStart) data.cell.styles.lineWidth = { top: 0.1, right: 0.1, bottom: 0.1, left: 0.6 };
    },
  });

  return (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
}

/** Generates and downloads a printable A4 PDF of the given month's schedule, laid out the same
 * way the on-screen table is: one row per employee, one (or two, for a plain weekday) column per
 * day. The month is split into two half-month tables stacked on the page - same as the paper
 * schedule this is modeled on - so each table has roughly half the columns and can use a much
 * larger, easily printable font. */
export async function exportScheduleToPdf(
  year: number,
  month: number,
  employees: Employee[],
  assignments: Assignment[],
): Promise<void> {
  const dayColumns = buildDayColumns(year, month);
  const splitAt = Math.ceil(dayColumns.length / 2);
  const firstHalf = dayColumns.slice(0, splitAt);
  const secondHalf = dayColumns.slice(splitAt);

  const hoursByCellKind = new Map<string, number>();
  const totalHoursByEmployee = new Map<string, number>();
  assignments.forEach((a) => {
    const k = `${a.date}|${a.employeeId}|${a.shift.kind}`;
    hoursByCellKind.set(k, (hoursByCellKind.get(k) ?? 0) + a.shift.hours);
    totalHoursByEmployee.set(a.employeeId, (totalHoursByEmployee.get(a.employeeId) ?? 0) + a.shift.hours);
  });

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  await ensureCzechFont(doc);
  doc.setFont('DejaVuSans', 'normal');

  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 8;

  doc.setFont('DejaVuSans', 'bold');
  doc.setFontSize(16);
  doc.text(`Rozvrh směn – ${MONTH_NAMES[month]} ${year}`, margin, margin + 5);

  const afterFirst = renderHalfTable(
    doc,
    firstHalf,
    employees,
    hoursByCellKind,
    margin + 11,
    margin,
    pageWidth,
    false,
    totalHoursByEmployee,
  );
  renderHalfTable(
    doc,
    secondHalf,
    employees,
    hoursByCellKind,
    afterFirst + 6,
    margin,
    pageWidth,
    true,
    totalHoursByEmployee,
  );

  const filename = `planovac-smen-${year}-${String(month + 1).padStart(2, '0')}.pdf`;
  doc.save(filename);
}
