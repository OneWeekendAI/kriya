import { createClient, SupabaseClient } from "@supabase/supabase-js";

const CONFIG_KEY = "kriya.supabase";

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export function loadConfig(): SupabaseConfig | null {
  const raw = localStorage.getItem(CONFIG_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SupabaseConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: SupabaseConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function clearConfig(): void {
  localStorage.removeItem(CONFIG_KEY);
}

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    const config = loadConfig();
    if (!config) throw new Error("Supabase not configured");
    client = createClient(config.url, config.anonKey);
  }
  return client;
}
