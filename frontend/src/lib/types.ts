export type IssueStatus = "backlog" | "todo" | "in_progress" | "done" | "cancelled";
export type IssuePriority = "none" | "low" | "medium" | "high" | "urgent";

export const STATUSES: IssueStatus[] = ["backlog", "todo", "in_progress", "done", "cancelled"];
export const PRIORITIES: IssuePriority[] = ["none", "low", "medium", "high", "urgent"];

export interface Member {
  user_id: string;
  display_name: string;
  email: string;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  color: string;
}

export interface Issue {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assignee_id: string | null;
  due_date: string | null;
  created_by: string | null;
  created_by_agent: string | null;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  issue_id: string;
  author_id: string | null;
  agent_name: string | null;
  body: string;
  created_at: string;
}

export interface Activity {
  id: number;
  issue_id: string;
  actor_id: string | null;
  agent_name: string | null;
  action: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}
