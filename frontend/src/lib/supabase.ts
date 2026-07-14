// The Supabase project is build-time configuration, not something users type
// into the UI: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see
// .env.example) before `npm run dev` / building the app.
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url: string | undefined = import.meta.env.VITE_SUPABASE_URL;
const anonKey: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY;

export function isConfigured(): boolean {
  return Boolean(url && anonKey);
}

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    if (!url || !anonKey) throw new Error("Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see frontend/.env.example)");
    client = createClient(url.replace(/\/$/, ""), anonKey);
  }
  return client;
}
