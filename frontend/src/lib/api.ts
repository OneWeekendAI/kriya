// Every Supabase query in the app lives here — components never build queries.
// Identity and agent attribution are handled by database triggers; this layer
// deliberately never writes created_by / author_id / *_agent columns.
import { supabase } from "./supabase";
import type { Activity, AgentKey, Comment, Issue, IssuePriority, IssueStatus, Member, Project } from "./types";

export async function listMembers(): Promise<Member[]> {
  const { data, error } = await supabase().from("members").select("*").order("display_name");
  if (error) throw error;
  return data;
}

export async function inviteMember(email: string): Promise<void> {
  // Upsert: re-inviting the same address is a no-op, not an error.
  const { error } = await supabase().from("invites").upsert({ email: email.toLowerCase() });
  if (error) throw error;
}

/** Remove a teammate. The database forbids removing yourself. */
export async function removeMember(userId: string): Promise<void> {
  const { error, count } = await supabase()
    .from("members").delete({ count: "exact" }).eq("user_id", userId);
  if (error) throw error;
  if (!count) throw new Error("Member could not be removed (you can't remove yourself).");
}

/** Withdraw an invite that hasn't been redeemed yet. */
export async function revokeInvite(email: string): Promise<void> {
  const { error } = await supabase().from("invites").delete().eq("email", email.toLowerCase());
  if (error) throw error;
}

/** Invites that haven't been redeemed yet (consumed on signup by the DB). */
export async function listPendingInvites(): Promise<{ email: string; created_at: string }[]> {
  const { data, error } = await supabase()
    .from("invites").select("email, created_at").order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Invite a teammate with a real signup email (the `invite` Edge Function).
 * Falls back to recording a plain invite (no email) only when the function
 * isn't deployed (404), so the flow still works on a bare-schema self-host.
 * Any other function error (SMTP, auth, ...) is surfaced to the caller.
 */
export async function inviteTeammate(email: string, name?: string): Promise<{ emailed: boolean }> {
  const { data, error } = await supabase().functions.invoke("invite", { body: { email, name } });
  if (error) {
    const resp = (error as { context?: Response }).context;
    if (resp instanceof Response && resp.status !== 404) {
      let detail = "";
      try {
        detail = (await resp.json())?.error ?? "";
      } catch { /* body wasn't JSON */ }
      throw new Error(detail || `invite failed (HTTP ${resp.status})`);
    }
    await inviteMember(email);
    return { emailed: false };
  }
  return { emailed: !!data?.emailed };
}

// --- Agent keys (Connect your agent) ---------------------------------------

export async function listAgentKeys(): Promise<AgentKey[]> {
  const { data, error } = await supabase()
    .from("agent_keys")
    .select("id, agent_name, key_prefix, created_at, last_used_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

/** Mints a key; the returned plaintext `key` is shown once and never stored. */
export async function createAgentKey(agentName: string): Promise<{ id: string; agent_name: string; key: string }> {
  const { data, error } = await supabase().rpc("create_agent_key", { agent_name: agentName });
  if (error) throw error;
  return data;
}

export async function revokeAgentKey(id: string): Promise<void> {
  const { error } = await supabase().from("agent_keys").delete().eq("id", id);
  if (error) throw error;
}

export async function listProjects(): Promise<Project[]> {
  const { data, error } = await supabase().from("projects").select("id, key, name, color").order("name");
  if (error) throw error;
  return data;
}

export async function createProject(key: string, name: string): Promise<Project> {
  const { data, error } = await supabase()
    .from("projects")
    .insert({ key: key.toUpperCase(), name })
    .select("id, key, name, color")
    .single();
  if (error) throw error;
  return data;
}

export async function listIssues(projectId: string): Promise<Issue[]> {
  const { data, error } = await supabase()
    .from("issues")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function createIssue(
  projectId: string,
  fields: { title: string; description?: string; status?: IssueStatus; priority?: IssuePriority }
): Promise<void> {
  const { error } = await supabase().from("issues").insert({ project_id: projectId, ...fields });
  if (error) throw error;
}

export async function updateIssue(
  issueId: string,
  patch: Partial<Pick<Issue, "title" | "description" | "status" | "priority" | "assignee_id" | "due_date">>
): Promise<void> {
  const { error } = await supabase().from("issues").update(patch).eq("id", issueId);
  if (error) throw error;
}

export async function listComments(issueId: string): Promise<Comment[]> {
  const { data, error } = await supabase()
    .from("comments").select("*").eq("issue_id", issueId).order("created_at");
  if (error) throw error;
  return data;
}

export async function addComment(issueId: string, body: string): Promise<void> {
  const { error } = await supabase().from("comments").insert({ issue_id: issueId, body });
  if (error) throw error;
}

export async function listActivity(issueId: string): Promise<Activity[]> {
  const { data, error } = await supabase()
    .from("activity").select("*").eq("issue_id", issueId).order("created_at");
  if (error) throw error;
  return data;
}

/** The agent feed: everything AI agents did across the workspace, newest first. */
export async function listAgentActivity(limit = 100): Promise<(Activity & { issue: { number: number; title: string; project_id: string } })[]> {
  const { data, error } = await supabase()
    .from("activity")
    .select("*, issue:issues!inner(number, title, project_id)")
    .not("agent_name", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data as never;
}

/** Subscribe to live changes on the tables that drive the UI. Returns unsubscribe. */
// Channel topics must be unique per subscriber: reusing a topic returns the
// already-subscribed channel, and adding callbacks to it throws.
let liveSeq = 0;
export function onWorkspaceChange(callback: () => void): () => void {
  const channel = supabase()
    .channel(`kriya-live-${++liveSeq}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "issues" }, callback)
    .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, callback)
    .on("postgres_changes", { event: "*", schema: "public", table: "activity" }, callback)
    .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, callback)
    .subscribe();
  return () => {
    void supabase().removeChannel(channel);
  };
}
