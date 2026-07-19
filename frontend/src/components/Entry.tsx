// One ledger entry — the issue card shared by the bento and stream boards.
import type { Issue, Member, Project } from "../lib/types";

export const initial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

export function Entry({
  issue,
  project,
  members,
  onSelect,
  draggable = false,
}: {
  issue: Issue;
  project: Project;
  members: Member[];
  onSelect: (issue: Issue) => void;
  draggable?: boolean;
}) {
  const assignee = members.find((m) => m.user_id === issue.assignee_id);
  const closed = issue.status === "done" || issue.status === "cancelled";
  return (
    <article
      className={`entry${closed ? " is-closed" : ""}`}
      draggable={draggable}
      onDragStart={draggable ? (e) => e.dataTransfer.setData("issue-id", issue.id) : undefined}
      onClick={() => onSelect(issue)}
    >
      <span className="entry-id">
        {project.key}-{issue.number}
        {issue.status === "in_progress" && <span className="pulse">●</span>}
      </span>
      <p className="entry-title">{issue.title}</p>
      <div className="entry-meta">
        {issue.assignee_agent ? (
          <>
            <span className="av av--agent">{initial(issue.assignee_agent)}</span>
            <span>{issue.assignee_agent}</span>
          </>
        ) : issue.created_by_agent ? (
          <>
            <span className="av av--agent">{initial(issue.created_by_agent)}</span>
            <span>{issue.created_by_agent}</span>
          </>
        ) : (
          assignee && <span className="av">{initial(assignee.display_name)}</span>
        )}
        {issue.needs_review && <span className="review-flag">review</span>}
        {issue.priority !== "none" && <span className={`prio ${issue.priority}`}>{issue.priority}</span>}
      </div>
      {issue.status === "done" && <span className="stamp">Done</span>}
      {issue.status === "cancelled" && <span className="stamp stamp--muted">Void</span>}
    </article>
  );
}
