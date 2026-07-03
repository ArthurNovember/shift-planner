import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Assignment, Employee } from './types';
import { daysInMonth, toISODate } from './scheduler';

const WEEKDAY_LABELS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
const MONTH_NAMES = [
  'Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec',
];

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

/** Generates and downloads a printable PDF of the given month's schedule. */
export async function exportScheduleToPdf(
  year: number,
  month: number,
  employees: Employee[],
  assignments: Assignment[],
): Promise<void> {
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const totalDays = daysInMonth(year, month);

  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const byDate = new Map<string, Assignment[]>();
  assignments.forEach((a) => {
    if (!byDate.has(a.date)) byDate.set(a.date, []);
    byDate.get(a.date)!.push(a);
  });

  function dayShiftLines(day: number | null): { name: string; time: string }[] {
    if (day === null) return [];
    const iso = toISODate(new Date(year, month, day));
    return (byDate.get(iso) ?? [])
      .slice()
      .sort((a, b) => a.shift.start.localeCompare(b.shift.start))
      .map((a) => ({
        name: employeeById.get(a.employeeId)?.name ?? '?',
        time: `${a.shift.start}-${a.shift.end}`,
      }));
  }

  // A plain-text fallback per cell (also what a PDF text-selection/copy would show), even
  // though the actual visible rendering is drawn by hand in didDrawCell below so the
  // employee name can be bold and the time next to it can stay regular weight.
  const rows: string[][] = [];
  const cellData: { day: number | null; lines: { name: string; time: string }[] }[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    const weekDays = cells.slice(i, i + 7);
    rows.push(
      weekDays.map((day) => {
        if (day === null) return '';
        const lines = dayShiftLines(day);
        return [String(day), ...lines.map((l) => `${l.name} ${l.time}`)].join('\n');
      }),
    );
    cellData.push(weekDays.map((day) => ({ day, lines: day === null ? [] : dayShiftLines(day) })));
  }

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  await ensureCzechFont(doc);
  doc.setFont('DejaVuSans', 'normal');

  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;
  const colWidth = (pageWidth - margin * 2) / 7;

  doc.setFont('DejaVuSans', 'bold');
  doc.setFontSize(16);
  doc.text(`Plánovač směn – ${MONTH_NAMES[month]} ${year}`, margin, 14);

  const bodyFontSize = 8;
  const cellPad = 2;
  const lineHeight = bodyFontSize * 1.15 * 0.352778; // pt -> mm, matching autoTable's own line height
  const entryGap = lineHeight * 0.7; // blank space between the day number and each shift, and between shifts

  autoTable(doc, {
    startY: 20,
    margin: { left: margin, right: margin },
    head: [WEEKDAY_LABELS],
    body: rows,
    styles: {
      font: 'DejaVuSans',
      fontSize: bodyFontSize,
      cellPadding: cellPad,
      valign: 'top',
      lineColor: [200, 200, 200],
    },
    bodyStyles: {
      minCellHeight: 28,
    },
    headStyles: {
      font: 'DejaVuSans',
      fontStyle: 'bold',
      fillColor: [23, 182, 245],
      textColor: 255,
      halign: 'center',
      valign: 'middle',
      fontSize: 8,
      cellPadding: 1.5,
    },
    columnStyles: Object.fromEntries(WEEKDAY_LABELS.map((_, i) => [i, { cellWidth: colWidth }])),
    theme: 'grid',
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const info = cellData[data.row.index]?.[data.column.index];
      if (!info || info.day === null) return;
      // Reserve enough height for our own hand-drawn lines (day number + one per shift, each
      // with a blank gap after it), then blank the automatic text so it doesn't double up
      // with the manual drawing below.
      const totalLines = 1 + info.lines.length;
      const needed = totalLines * (lineHeight + entryGap) + cellPad * 2;
      data.cell.styles.minCellHeight = Math.max(data.cell.styles.minCellHeight ?? 0, needed);
      data.cell.text = [];
    },
    didDrawCell: (data) => {
      if (data.section !== 'body') return;
      const info = cellData[data.row.index]?.[data.column.index];
      if (!info || info.day === null) return;
      const { cell } = data;
      let y = cell.y + cellPad + lineHeight * 0.8;
      doc.setFontSize(bodyFontSize);
      doc.setFont('DejaVuSans', 'bold');
      doc.setTextColor(23, 182, 245); // same blue as the Po-Ne header row
      doc.text(String(info.day), cell.x + cellPad, y);
      doc.setTextColor(0, 0, 0);
      y += lineHeight + entryGap;
      info.lines.forEach((line) => {
        doc.setFont('DejaVuSans', 'bold');
        doc.text(line.name, cell.x + cellPad, y);
        const nameWidth = doc.getTextWidth(`${line.name} `);
        doc.setFont('DejaVuSans', 'normal');
        doc.text(line.time, cell.x + cellPad + nameWidth, y);
        y += lineHeight + entryGap;
      });
    },
  });

  const filename = `planovac-smen-${year}-${String(month + 1).padStart(2, '0')}.pdf`;
  doc.save(filename);
}
