// Every Supabase query in the app lives here — components never build queries.
// Identity and agent attribution are handled by database triggers; this layer
// deliberately never writes created_by / author_id / *_agent columns.
import { supabase } from "./supabase";
import type { Activity, Comment, Issue, IssuePriority, IssueStatus, Member, Project } from "./types";

export async function listMembers(): Promise<Member[]> {
  const { data, error } = await supabase().from("members").select("*").order("display_name");
  if (error) throw error;
  return data;
}

export async function inviteMember(email: string): Promise<void> {
  const { error } = await supabase().from("invites").insert({ email: email.toLowerCase() });
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
export function onWorkspaceChange(callback: () => void): () => void {
  const channel = supabase()
    .channel("kriya-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "issues" }, callback)
    .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, callback)
    .on("postgres_changes", { event: "*", schema: "public", table: "activity" }, callback)
    .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, callback)
    .subscribe();
  return () => {
    void supabase().removeChannel(channel);
  };
}
