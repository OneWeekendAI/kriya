import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Activity, Comment, Issue, IssueStatus, Member, Project } from "../lib/types";
import { PRIORITIES, STATUSES } from "../lib/types";
import { initial } from "./Entry";

const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Void",
};

/** Comments and activity interleaved by time: the issue's own ledger. */
type LedgerLine =
  | { kind: "comment"; at: string; id: string; c: Comment }
  | { kind: "activity"; at: string; id: string; a: Activity };

function Who({ actorId, agent, members }: { actorId: string | null; agent: string | null; members: Member[] }) {
  const human = members.find((m) => m.user_id === actorId)?.display_name;
  if (agent) {
    return (
      <span className="who">
        <strong className="agent-mark">{agent}</strong>
        {human && <span className="for"> for {human}</span>}
      </span>
    );
  }
  return <span className="who"><strong>{human ?? "someone"}</strong></span>;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

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
  const [agents, setAgents] = useState<string[]>([]);
  const [newComment, setNewComment] = useState("");
  const [description, setDescription] = useState(issue.description);

  useEffect(() => {
    setDescription(issue.description);
    void api.listComments(issue.id).then(setComments);
    void api.listActivity(issue.id).then(setActivity);
  }, [issue]);

  useEffect(() => {
    void api.knownAgents().then(setAgents);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const ledger: LedgerLine[] = [
    ...comments.map((c) => ({ kind: "comment" as const, at: c.created_at, id: `c${c.id}`, c })),
    ...activity.map((a) => ({ kind: "activity" as const, at: a.created_at, id: `a${a.id}`, a })),
  ].sort((x, y) => x.at.localeCompare(y.at));

  return (
    <>
      <div className="panel-backdrop" onClick={onClose} />
      <aside className="issue-panel">
        <header>
          <span className="entry-id">
            {project.key}-{issue.number}
            {issue.created_by_agent && (
              <span className="agent-mark" title={`Created by ${issue.created_by_agent}`}>
                · by {issue.created_by_agent}
              </span>
            )}
          </span>
          <button className="close" onClick={onClose}>esc ✕</button>
        </header>

        <h2>{issue.title}</h2>

        {issue.needs_review && (
          <div className="review-bar">
            <span>
              {issue.assignee_agent ?? "An agent"} finished this — awaiting your review.
            </span>
            <button className="btn-primary" onClick={() => patch({ status: "done" })}>
              Approve → Done
            </button>
            <button onClick={() => patch({ needs_review: false, status: "in_progress" })}>
              Send back
            </button>
          </div>
        )}

        <div className="status-chips">
          {STATUSES.map((s) => (
            <button
              key={s}
              className={issue.status === s ? "active" : ""}
              onClick={() => issue.status !== s && patch({ status: s })}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>

        <div className="fields">
          <div className="field-row">
            <span className="overline">Priority</span>
            <select value={issue.priority} onChange={(e) => patch({ priority: e.target.value as Issue["priority"] })}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="field-row">
            <span className="overline">Assignee</span>
            <select
              value={issue.assignee_id ?? ""}
              onChange={(e) => patch({ assignee_id: e.target.value || null })}
            >
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
            </select>
          </div>
          {(agents.length > 0 || issue.assignee_agent) && (
            <div className="field-row">
              <span className="overline">Agent</span>
              <select
                value={issue.assignee_agent ?? ""}
                onChange={(e) => patch({ assignee_agent: e.target.value || null })}
              >
                <option value="">No agent</option>
                {[...new Set([...agents, ...(issue.assignee_agent ? [issue.assignee_agent] : [])])].map(
                  (a) => <option key={a} value={a}>{a}</option>,
                )}
              </select>
            </div>
          )}
          <div className="field-row">
            <span className="overline">Due</span>
            <input
              type="date"
              value={issue.due_date ?? ""}
              onChange={(e) => patch({ due_date: e.target.value || null })}
            />
          </div>
        </div>

        <textarea
          placeholder="Description (markdown)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== issue.description && patch({ description })}
        />

        <section>
          <span className="overline">Ledger</span>
          <div className="ledger-stream">
            {ledger.map((line) => (
              <div key={line.id} className="ledger-item">
                <span className={`av${(line.kind === "comment" ? line.c.agent_name : line.a.agent_name) ? " av--agent" : ""}`}>
                  {initial(
                    line.kind === "comment"
                      ? line.c.agent_name ?? members.find((m) => m.user_id === line.c.author_id)?.display_name ?? "?"
                      : line.a.agent_name ?? members.find((m) => m.user_id === line.a.actor_id)?.display_name ?? "?",
                  )}
                </span>
                <div className="grow">
                  {line.kind === "comment" ? (
                    <>
                      <Who actorId={line.c.author_id} agent={line.c.agent_name} members={members} />
                      <time>{clock(line.at)}</time>
                      <p className="what said">{line.c.body}</p>
                    </>
                  ) : (
                    <>
                      <Who actorId={line.a.actor_id} agent={line.a.agent_name} members={members} />
                      <time>{clock(line.at)}</time>
                      <p className="what">
                        {line.a.action === "created"
                          ? "opened this entry"
                          : line.a.action === "review"
                          ? line.a.new_value === "requested"
                            ? "submitted this for review"
                            : "review cleared"
                          : line.a.action === "agent_assignee"
                          ? `agent: ${line.a.old_value ?? "—"} → ${line.a.new_value ?? "—"}`
                          : `${line.a.action}: ${line.a.old_value ?? "—"} → ${line.a.new_value ?? "—"}`}
                      </p>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <form className="comment-box" onSubmit={comment}>
          <input
            placeholder="Write in the ledger…"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
          />
          <button type="submit" className="btn-primary">Log it</button>
        </form>
      </aside>
    </>
  );
}
