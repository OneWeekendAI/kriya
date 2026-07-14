import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import * as api from "../lib/api";
import type { Issue, Member, Project } from "../lib/types";
import { supabase } from "../lib/supabase";
import { Board } from "../components/Board";
import { IssuePanel } from "../components/IssuePanel";
import { AgentFeed } from "../components/AgentFeed";
import { ConnectAgent } from "../components/ConnectAgent";

interface Field {
  name: string;
  placeholder: string;
  required?: boolean;
}

// In-app replacement for window.prompt/alert — those are no-ops in Tauri's webview.
function FormDialog({
  title,
  fields,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  fields: Field[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <form onSubmit={submit}>
          {fields.map((f) => (
            <input
              key={f.name}
              placeholder={f.placeholder}
              required={f.required}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            />
          ))}
          <div className="row">
            <button type="submit" disabled={busy}>{submitLabel}</button>
            <button type="button" className="link" onClick={onClose}>Cancel</button>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      </div>
    </div>
  );
}

export function Workspace({ session }: { session: Session }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [current, setCurrent] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [selected, setSelected] = useState<Issue | null>(null);
  const [view, setView] = useState<"board" | "agents" | "connect">("board");
  const [dialog, setDialog] = useState<null | "project" | "invite">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [notMember, setNotMember] = useState(false);

  const refresh = useCallback(async () => {
    const [ps, ms] = await Promise.all([api.listProjects(), api.listMembers()]);
    setProjects(ps);
    setMembers(ms);
    setNotMember(!ms.some((m) => m.user_id === session.user.id));
    setCurrent((c) => c ?? ps[0] ?? null);
  }, [session.user.id]);

  const refreshIssues = useCallback(async () => {
    if (!current) return;
    const list = await api.listIssues(current.id);
    setIssues(list);
    setSelected((s) => (s ? list.find((i) => i.id === s.id) ?? null : null));
  }, [current]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void refreshIssues();
  }, [refreshIssues]);
  useEffect(() => api.onWorkspaceChange(() => {
    void refresh();
    void refreshIssues();
  }), [refresh, refreshIssues]);

  if (notMember) {
    return (
      <main className="centered">
        <h1>Kriya</h1>
        <p>Your account isn't a member of this workspace yet. Ask a teammate to invite {session.user.email}, then sign in again.</p>
        <button onClick={() => supabase().auth.signOut()}>Sign out</button>
      </main>
    );
  }

  return (
    <div className="workspace">
      <aside className="sidebar">
        <h1>Kriya</h1>
        <nav>
          {projects.map((p) => (
            <button
              key={p.id}
              className={current?.id === p.id && view === "board" ? "active" : ""}
              onClick={() => { setCurrent(p); setView("board"); setSelected(null); }}
            >
              <span className="dot" style={{ background: p.color }} /> {p.key} — {p.name}
            </button>
          ))}
          <button onClick={() => setDialog("project")}>+ New project</button>
        </nav>
        <nav className="bottom">
          <button className={view === "agents" ? "active" : ""} onClick={() => setView("agents")}>
            🤖 Agent activity
          </button>
          <button className={view === "connect" ? "active" : ""} onClick={() => setView("connect")}>
            🔌 Connect your agent
          </button>
          <button onClick={() => setDialog("invite")}>Invite teammate</button>
          <button onClick={() => supabase().auth.signOut()}>Sign out</button>
        </nav>
      </aside>

      <main className="content">
        {notice && (
          <div className="notice">
            {notice}
            <button className="link" onClick={() => setNotice(null)}>dismiss</button>
          </div>
        )}
        {view === "agents" ? (
          <AgentFeed members={members} projects={projects} />
        ) : view === "connect" ? (
          <ConnectAgent />
        ) : current ? (
          <Board project={current} issues={issues} onSelect={setSelected} onChanged={refreshIssues} />
        ) : (
          <p>Create a project to get started.</p>
        )}
      </main>

      {selected && view === "board" && (
        <IssuePanel
          issue={selected}
          project={current!}
          members={members}
          onClose={() => setSelected(null)}
          onChanged={refreshIssues}
        />
      )}

      {dialog === "project" && (
        <FormDialog
          title="New project"
          submitLabel="Create"
          fields={[
            { name: "key", placeholder: "Key (2–8 chars, e.g. KRI)", required: true },
            { name: "name", placeholder: "Project name", required: true },
          ]}
          onSubmit={async (v) => {
            const p = await api.createProject(v.key.trim(), v.name.trim());
            setCurrent(p);
            setView("board");
            await refresh();
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "invite" && (
        <FormDialog
          title="Invite teammate"
          submitLabel="Send invite"
          fields={[
            { name: "email", placeholder: "Email", required: true },
            { name: "name", placeholder: "Name (optional)" },
          ]}
          onSubmit={async (v) => {
            const email = v.email.trim();
            const { emailed } = await api.inviteTeammate(email, v.name?.trim() || undefined);
            setNotice(
              emailed
                ? `Invite email sent to ${email}. They join with the 6-digit code from the email (or the emailed link on web).`
                : `${email} is pre-authorized, but no email was sent (invite function not deployed). Ask them to sign up with that address.`
            );
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
