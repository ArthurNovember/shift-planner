interface WorkingEmployee {
  id: string;
  color: string;
}

interface Props {
  workingEmployees: WorkingEmployee[];
}

export function SpaceScene({ workingEmployees }: Props) {
  return (
    <div className="space-scene" aria-hidden="true">
      <div className="orbit-system">
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
                animationDirection: reverse ? 'reverse' : 'normal',
              }}
            >
              <div className="planet" style={{ background: emp.color, boxShadow: `0 0 12px 4px ${emp.color}80` }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
