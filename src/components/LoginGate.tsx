import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { ReactNode, FormEvent } from 'react';
import { supabase, SHARED_LOGIN_EMAIL } from '../supabaseClient';

interface Props {
  children: ReactNode;
}

export function LoginGate({ children }: Props) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: SHARED_LOGIN_EMAIL, password });
    if (error) setError('Nesprávné heslo.');
    setSubmitting(false);
  }

  if (session === undefined) {
    return (
      <div className="auth-screen">
        <p className="muted">Načítání…</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="auth-screen">
        <form className="auth-form panel" onSubmit={handleSubmit}>
          <h1>
            Plánovač <span className="accent">směn</span>
          </h1>
          <p className="muted">Zadejte sdílené heslo pro tým</p>
          <input
            type="password"
            className="auth-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Heslo"
            autoFocus
          />
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" className="primary-btn" disabled={submitting || password.length === 0}>
            {submitting ? 'Přihlašuji…' : 'Přihlásit'}
          </button>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
