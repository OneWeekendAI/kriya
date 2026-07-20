import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  navigateToWorkspace,
  type PendingInvite,
} from "../lib/workspace";
import { Mark } from "../components/Mark";

// Shown to a freshly-signed-up user who isn't a member of any workspace yet.
// Two paths: accept a pending invite (if any), or create a new workspace.
export function Onboarding() {
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);

  useEffect(() => {
    void supabase().rpc("my_pending_invites").then(({ data, error: e }) => {
      if (!e && data) setInvites(data as PendingInvite[]);
      setLoading(false);
    });
  }, []);

  async function acceptInvite(inviteSlug: string) {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase().rpc("accept_invite", {
      p_workspace_slug: inviteSlug,
    });
    if (e) { setError(e.message); setBusy(false); return; }
    navigateToWorkspace(inviteSlug);
  }

  function randomSuffix(): string {
    // 4-char base36 — short, avoids look-alike chars, low collision rate.
    return Math.random().toString(36).slice(2, 6).replace(/[^a-z0-9]/g, "x");
  }

  async function createWorkspace(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSuggestion(null);
    const cleanSlug = slug.trim().toLowerCase();
    const { error: err } = await supabase().rpc("create_workspace", {
      p_slug: cleanSlug,
      p_name: name.trim(),
    });
    if (err) {
      // Postgres unique_violation. supabase-js surfaces .code on PostgrestError.
      const isTaken = (err as { code?: string }).code === "23505"
        || /duplicate key|already exists/i.test(err.message);
      if (isTaken) {
        setError(`"${cleanSlug}" is already taken.`);
        setSuggestion(`${cleanSlug}-${randomSuffix()}`);
      } else {
        setError(err.message);
      }
      setBusy(false);
      return;
    }
    navigateToWorkspace(cleanSlug);
  }

  if (loading) return null;

  return (
    <main className="centered">
      <div className="auth-mark">
        <span className="auth-face"><Mark size={52} /></span>
        <h1>Kriya<em>.</em></h1>
        <span className="auth-tagline">pick a workspace to get started</span>
      </div>

      {invites.length > 0 && (
        <div style={{ width: "100%", maxWidth: 360, marginBottom: 24 }}>
          <p className="overline">Pending invites</p>
          {invites.map((inv) => (
            <div key={inv.workspace_id} className="row" style={{ marginBottom: 8 }}>
              <span style={{ flex: 1 }}>{inv.name} <span className="mono">({inv.slug})</span></span>
              <button
                className="btn-primary"
                disabled={busy}
                onClick={() => void acceptInvite(inv.slug)}
              >
                Join
              </button>
            </div>
          ))}
          <p className="overline" style={{ marginTop: 16 }}>Or create your own</p>
        </div>
      )}

      <form onSubmit={createWorkspace} style={{ width: "100%", maxWidth: 360 }}>
        <input
          placeholder="Workspace name (e.g. Acme Corp)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          minLength={1}
          maxLength={80}
        />
        <input
          placeholder="URL slug (e.g. acme)"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
          required
          pattern="[a-z][-a-z0-9]{1,38}[a-z0-9]"
          title="lowercase letters, digits, dashes; 3–40 chars; must start with a letter and end with letter/digit"
        />
        <button type="submit" className="btn-primary" disabled={busy}>
          Create workspace
        </button>
        {error && <p className="error">{error}</p>}
        {suggestion && (
          <p style={{ fontSize: 13, opacity: 0.8 }}>
            Try{" "}
            <button
              type="button"
              className="link"
              onClick={() => { setSlug(suggestion); setSuggestion(null); setError(null); }}
            >
              <span className="mono">{suggestion}</span>
            </button>{" "}
            instead.
          </p>
        )}
      </form>

      <div className="auth-switch" style={{ marginTop: 16 }}>
        <button className="link" onClick={() => supabase().auth.signOut()}>Sign out</button>
      </div>
    </main>
  );
}
