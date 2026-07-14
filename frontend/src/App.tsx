// Blueprint UI: two top-level states — needs auth, workspace. The Supabase
// project comes from build-time env (see lib/supabase.ts), not the UI.
// Deliberately unstyled beyond basic layout; design pass comes later.
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isConfigured, supabase } from "./lib/supabase";
import { Auth } from "./screens/Auth";
import { Workspace } from "./screens/Workspace";
import "./App.css";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isConfigured()) return;
    supabase().auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase().auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!isConfigured()) {
    return (
      <main className="centered">
        <h1>Kriya</h1>
        <p>
          This build isn't connected to a Supabase project. Copy <code>frontend/.env.example</code> to{" "}
          <code>frontend/.env</code>, fill in <code>VITE_SUPABASE_URL</code> and{" "}
          <code>VITE_SUPABASE_ANON_KEY</code> (Supabase dashboard → Settings → API), and restart.
        </p>
      </main>
    );
  }
  if (!ready) return null;
  if (!session) return <Auth />;
  return <Workspace session={session} />;
}
