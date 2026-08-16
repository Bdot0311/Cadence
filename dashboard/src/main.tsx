import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import { App } from './App.js';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  document.getElementById('root')!.innerHTML = '<main class="fatal"><strong>Cadence is not configured.</strong><p>Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart the dashboard.</p></main>';
} else {
  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  createRoot(document.getElementById('root')!).render(
    <StrictMode><App supabase={supabase} apiUrl={(import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8080'} /></StrictMode>,
  );
}
