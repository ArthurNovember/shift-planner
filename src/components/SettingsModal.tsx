import { useEffect, useState } from 'react';
import type { Employee } from '../types';
import type { Theme } from '../storage';
import { EmployeeManager } from './EmployeeManager';
import { SpaceScene } from './SpaceScene';

interface WorkingEmployee {
  id: string;
  color: string;
}

interface Props {
  employees: Employee[];
  onChangeEmployees: (employees: Employee[]) => void;
  workingEmployees: WorkingEmployee[];
  theme: Theme;
  onToggleTheme: () => void;
  showIcsExport: boolean;
  onToggleIcsExport: () => void;
  onLogout: () => void;
}

/** Gear icon that opens everything infrequently-touched in one place: the theme switch, the
 * employee list, and signing out - kept out of the main view since none of it is needed
 * day-to-day. The orbit graphic (who's currently clocked in) rides along as the modal's header
 * art, shrunk down from its old full-size spot on the main page. */
export function SettingsModal({
  employees,
  onChangeEmployees,
  workingEmployees,
  theme,
  onToggleTheme,
  showIcsExport,
  onToggleIcsExport,
  onLogout,
}: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="icon-btn settings-gear"
        onClick={() => setOpen(true)}
        aria-label="Nastavení"
        title="Nastavení"
      >
        ⚙
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal-panel settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-orbit">
              <SpaceScene workingEmployees={workingEmployees} />
              <button
                type="button"
                className="icon-btn settings-modal-close"
                onClick={() => setOpen(false)}
                aria-label="Zavřít"
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <h2>Nastavení</h2>
              <label className="settings-row">
                <span className="theme-toggle-label">{theme === 'light' ? 'Světlý režim' : 'Tmavý režim'}</span>
                <button
                  type="button"
                  className="theme-toggle"
                  role="switch"
                  aria-checked={theme === 'light'}
                  aria-label="Přepnout světlý/tmavý režim"
                  onClick={onToggleTheme}
                >
                  <span className="theme-toggle-track">
                    <span className="theme-toggle-thumb" />
                  </span>
                </button>
              </label>
              <label className="settings-row">
                <span className="theme-toggle-label">Zobrazit stahování .ics kalendáře</span>
                <button
                  type="button"
                  className="switch"
                  role="switch"
                  aria-checked={showIcsExport}
                  aria-label="Zobrazit stahování .ics kalendáře"
                  onClick={onToggleIcsExport}
                >
                  <span className="switch-track">
                    <span className="switch-thumb" />
                  </span>
                </button>
              </label>
              <EmployeeManager employees={employees} onChange={onChangeEmployees} />
              <button type="button" className="secondary-btn settings-logout" onClick={onLogout}>
                Odhlásit
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
