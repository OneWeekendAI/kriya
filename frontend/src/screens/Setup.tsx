import { useState } from "react";
import { saveConfig } from "../lib/supabase";

export function Setup({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [anonKey, setAnonKey] = useState("");

  return (
    <main className="centered">
      <h1>Kriya</h1>
      <p>Connect your team's Supabase project (Settings → API in the Supabase dashboard).</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          saveConfig({ url: url.trim().replace(/\/$/, ""), anonKey: anonKey.trim() });
          onDone();
        }}
      >
        <input placeholder="https://xxxx.supabase.co" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <input placeholder="anon public key" value={anonKey} onChange={(e) => setAnonKey(e.target.value)} required />
        <button type="submit">Connect</button>
      </form>
    </main>
  );
}
