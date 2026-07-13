import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import * as api from "../lib/api";
import type { Issue, Member, Project } from "../lib/types";
import { supabase } from "../lib/supabase";
import { Board } from "../components/Board";
import { IssuePanel } from "../components/IssuePanel";
import { AgentFeed } from "../components/AgentFeed";

export function Workspace({ session }: { session: Session }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [current, setCurrent] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [selected, setSelected] = useState<Issue | null>(null);
  const [view, setView] = useState<"board" | "agents">("board");
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

  async function newProject() {
    const key = prompt("Project key (2–8 chars, e.g. KRI):")?.trim();
    const name = key && prompt("Project name:")?.trim();
    if (!key || !name) return;
    setCurrent(await api.createProject(key, name));
    await refresh();
  }

  async function invite() {
    const email = prompt("Teammate's email (they sign up after this):")?.trim();
    if (email) await api.inviteMember(email);
  }

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
          <button onClick={newProject}>+ New project</button>
        </nav>
        <nav className="bottom">
          <button className={view === "agents" ? "active" : ""} onClick={() => setView("agents")}>
            🤖 Agent activity
          </button>
          <button onClick={invite}>Invite teammate</button>
          <button onClick={() => supabase().auth.signOut()}>Sign out</button>
        </nav>
      </aside>

      <main className="content">
        {view === "agents" ? (
          <AgentFeed members={members} projects={projects} />
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
    </div>
  );
}
