import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Activity, Comment, Issue, Member, Project } from "../lib/types";
import { PRIORITIES, STATUSES } from "../lib/types";

function Who({ actorId, agent, members }: { actorId: string | null; agent: string | null; members: Member[] }) {
  const human = members.find((m) => m.user_id === actorId)?.display_name ?? "someone";
  return agent ? (
    <strong className="agent">🤖 {agent} <small>(for {human})</small></strong>
  ) : (
    <strong>{human}</strong>
  );
}

export function IssuePanel({
  issue,
  project,
  members,
  onClose,
  onChanged,
}: {
  issue: Issue;
  project: Project;
  members: Member[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [newComment, setNewComment] = useState("");
  const [description, setDescription] = useState(issue.description);

  useEffect(() => {
    setDescription(issue.description);
    void api.listComments(issue.id).then(setComments);
    void api.listActivity(issue.id).then(setActivity);
  }, [issue]);

  async function patch(fields: Parameters<typeof api.updateIssue>[1]) {
    await api.updateIssue(issue.id, fields);
    onChanged();
    setActivity(await api.listActivity(issue.id));
  }

  async function comment(e: React.FormEvent) {
    e.preventDefault();
    if (!newComment.trim()) return;
    await api.addComment(issue.id, newComment.trim());
    setNewComment("");
    setComments(await api.listComments(issue.id));
  }

  return (
    <aside className="issue-panel">
      <header>
        <span className="issue-id">{project.key}-{issue.number}</span>
        {issue.created_by_agent && <span className="agent-badge">🤖 created by {issue.created_by_agent}</span>}
        <button onClick={onClose}>✕</button>
      </header>

      <h2>{issue.title}</h2>

      <div className="fields">
        <label>
          Status
          <select value={issue.status} onChange={(e) => patch({ status: e.target.value as Issue["status"] })}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>
          Priority
          <select value={issue.priority} onChange={(e) => patch({ priority: e.target.value as Issue["priority"] })}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>
          Assignee
          <select
            value={issue.assignee_id ?? ""}
            onChange={(e) => patch({ assignee_id: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
          </select>
        </label>
        <label>
          Due
          <input
            type="date"
            value={issue.due_date ?? ""}
            onChange={(e) => patch({ due_date: e.target.value || null })}
          />
        </label>
      </div>

      <textarea
        placeholder="Description (markdown)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => description !== issue.description && patch({ description })}
      />

      <section>
        <h3>Comments</h3>
        {comments.map((c) => (
          <div key={c.id} className="comment">
            <Who actorId={c.author_id} agent={c.agent_name} members={members} />
            <p>{c.body}</p>
          </div>
        ))}
        <form onSubmit={comment}>
          <input placeholder="Add a comment…" value={newComment} onChange={(e) => setNewComment(e.target.value)} />
        </form>
      </section>

      <section>
        <h3>Activity</h3>
        <ul className="activity">
          {activity.map((a) => (
            <li key={a.id}>
              <Who actorId={a.actor_id} agent={a.agent_name} members={members} />{" "}
              {a.action === "created"
                ? "created this issue"
                : `changed ${a.action}: ${a.old_value ?? "—"} → ${a.new_value ?? "—"}`}
              <time>{new Date(a.created_at).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
