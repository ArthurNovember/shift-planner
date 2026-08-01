interface WorkingEmployee {
  id: string;
  color: string;
}

interface Props {
  workingEmployees: WorkingEmployee[];
}

/** Just the orbiting-planets graphic - one ring per employee currently clocked in, orbiting a
 * sun. Purely decorative (aria-hidden): who's actually working is already listed elsewhere. */
export function SpaceScene({ workingEmployees }: Props) {
  return (
    <div className="orbit-system" aria-hidden="true">
      <div className="orbit-core" />
      {workingEmployees.map((emp, i) => {
        const size = 110 + i * 62;
        const duration = 9 + i * 6;
        return (
          <div
            key={emp.id}
            className="orbit-ring"
            style={{
              width: size,
              height: size,
              animationDuration: `${duration}s`,
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
  );
}
