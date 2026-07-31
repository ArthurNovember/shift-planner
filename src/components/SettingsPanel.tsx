import { useState } from 'react';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

/** Collapsed-by-default section for settings that don't need to be visible day-to-day (currently
 * just the employee list) - keeps them out of the way without hiding them entirely. */
export function SettingsPanel({ children }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <section className="panel settings-panel">
      <button
        type="button"
        className="settings-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        Nastavení
        <span className={`settings-toggle-icon${open ? ' open' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && <div className="settings-content">{children}</div>}
    </section>
  );
}
