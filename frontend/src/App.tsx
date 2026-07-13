// Blueprint UI: three top-level states — needs config, needs auth, workspace.
// Deliberately unstyled beyond basic layout; design pass comes later.
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { loadConfig, supabase } from "./lib/supabase";
import { Setup } from "./screens/Setup";
import { Auth } from "./screens/Auth";
import { Workspace } from "./screens/Workspace";
import "./App.css";

export default function App() {
  const [configured, setConfigured] = useState(() => loadConfig() !== null);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!configured) {
      setReady(true);
      return;
    }
    supabase().auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase().auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [configured]);

  if (!ready) return null;
  if (!configured) return <Setup onDone={() => setConfigured(true)} />;
  if (!session) return <Auth />;
  return <Workspace session={session} />;
}
