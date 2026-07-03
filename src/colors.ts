const PALETTE = [
  "#2563eb",
  "#c616ea",
  "#61bb3a",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
];

export function employeeColor(
  employeeId: string,
  employeeIds: string[],
): string {
  const idx = employeeIds.indexOf(employeeId);
  if (idx === -1) return "#6b7280";
  return PALETTE[idx % PALETTE.length];
}
