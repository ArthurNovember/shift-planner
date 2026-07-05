import type { Assignment, Employee } from "../types";
import { employeeColor } from "../colors";

interface WorkingEmployee {
  id: string;
  color: string;
}

interface Props {
  workingEmployees: WorkingEmployee[];
  employees: Employee[];
  todayAssignments: Assignment[];
}

const KIND_LABELS: Record<Assignment["shift"]["kind"], string> = {
  morning: "Ranní",
  afternoon: "Odpolední",
  weekend: "Víkendová",
};

export function SpaceScene({
  workingEmployees,
  employees,
  todayAssignments,
}: Props) {
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const sorted = [...todayAssignments].sort((a, b) =>
    a.shift.start.localeCompare(b.shift.start),
  );

  return (
    <div className="space-scene">
      <div className="space-scene-today">
        <h2>Dnešní směny</h2>
        {sorted.length === 0 ? (
          <p className="muted">Dnes nikdo nemá naplánovanou směnu.</p>
        ) : (
          <ul className="today-shifts-list">
            {sorted.map((a, i) => {
              const emp = employeeById.get(a.employeeId);
              if (!emp) return null;
              return (
                <li key={i} className="today-shift-row">
                  <span
                    className="color-dot"
                    style={{ background: employeeColor(emp.id, employees) }}
                  />
                  <span className="today-shift-name">{emp.name}</span>
                  <span className="today-shift-kind">
                    {KIND_LABELS[a.shift.kind]}
                  </span>
                  <span className="today-shift-time">
                    {a.shift.start}–{a.shift.end}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="orbit-system" aria-hidden="true">
        <div className="orbit-core" />
        {workingEmployees.map((emp, i) => {
          const size = 110 + i * 62;
          const duration = 9 + i * 6;
          const reverse = i % 2 === 1;
          return (
            <div
              key={emp.id}
              className="orbit-ring"
              style={{
                width: size,
                height: size,
                animationDuration: `${duration}s`,
                animationDirection: reverse ? "reverse" : "normal",
              }}
            >
              <div
                className="planet"
                style={{
                  background: emp.color,
                  boxShadow: `0 0 12px 4px ${emp.color}80`,
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
