import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY environment variables.');
}

export const supabase = createClient(url, anonKey);

export const SHARED_LOGIN_EMAIL = import.meta.env.VITE_SHARED_LOGIN_EMAIL as string;
