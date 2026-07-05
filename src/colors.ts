import type { Employee } from "./types";

export const PALETTE = [
  "#2563eb",
  "#c616ea",
  "#61bb3a",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
];

export function employeeColor(employeeId: string, employees: Employee[]): string {
  const idx = employees.findIndex((e) => e.id === employeeId);
  if (idx === -1) return "#6b7280";
  return employees[idx].color ?? PALETTE[idx % PALETTE.length];
}
