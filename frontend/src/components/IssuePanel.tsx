import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Activity, Comment, Issue, IssueLink, IssueStatus, Member, Project } from "../lib/types";
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

/** A run of consecutive ledger lines by the same actor, close together in time. */
type LedgerSession = { id: string; agent: string | null; actorId: string | null; lines: LedgerLine[] };

const SESSION_GAP_MS = 30 * 60 * 1000;

function actorOf(line: LedgerLine): { agent: string | null; actorId: string | null } {
  return line.kind === "comment"
    ? { agent: line.c.agent_name, actorId: line.c.author_id }
    : { agent: line.a.agent_name, actorId: line.a.actor_id };
}

function groupSessions(ledger: LedgerLine[]): LedgerSession[] {
  const sessions: LedgerSession[] = [];
  for (const line of ledger) {
    const { agent, actorId } = actorOf(line);
    const last = sessions[sessions.length - 1];
    const prev = last?.lines[last.lines.length - 1];
    const sameActor = last && last.agent === agent && last.actorId === actorId;
    const closeEnough =
      prev && new Date(line.at).getTime() - new Date(prev.at).getTime() <= SESSION_GAP_MS;
    if (sameActor && closeEnough) {
      last.lines.push(line);
    } else {
      sessions.push({ id: line.id, agent, actorId, lines: [line] });
    }
  }
  return sessions;
}

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

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "Jul 19, 10:02" for a single line, "Jul 19, 10:02 – 10:41" for a span. */
function sessionSpan(s: LedgerSession): string {
  const first = s.lines[0].at;
  const last = s.lines[s.lines.length - 1].at;
  return first === last || hhmm(first) === hhmm(last) ? clock(first) : `${clock(first)} – ${hhmm(last)}`;
}

function describe(a: Activity): string {
  if (a.action === "created") return "opened this entry";
  if (a.action === "review") return a.new_value === "requested" ? "submitted this for review" : "review cleared";
  if (a.action === "agent_assignee") return `agent: ${a.old_value ?? "—"} → ${a.new_value ?? "—"}`;
  return `${a.action}: ${a.old_value ?? "—"} → ${a.new_value ?? "—"}`;
}

export function IssuePanel({
  issue,
  project,
  members,
  onClose,
  onChanged,
  inline = false,
}: {
  issue: Issue;
  project: Project;
  members: Member[];
  onClose: () => void;
  onChanged: () => void;
  inline?: boolean;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [links, setLinks] = useState<IssueLink[]>([]);
  const [newComment, setNewComment] = useState("");
  const [description, setDescription] = useState(issue.description);

  useEffect(() => {
    setDescription(issue.description);
    void api.listComments(issue.id).then(setComments);
    void api.listActivity(issue.id).then(setActivity);
    void api.listIssueLinks(issue.id).then(setLinks);
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
      {!inline && <div className="panel-backdrop" onClick={onClose} />}
      <aside className={`issue-panel${inline ? " is-inline" : ""}`}>
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

        {links.length > 0 && (
          <section>
            <span className="overline">Pull requests</span>
            <ul className="ruled-list">
              {links.map((l) => (
                <li key={l.id}>
                  <span className="grow">
                    <a href={l.url} target="_blank" rel="noreferrer">
                      {l.title || l.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
                    </a>
                  </span>
                  <span className={`pr-state pr-state--${l.state}`}>{l.state}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <textarea
          placeholder="Description (markdown)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== issue.description && patch({ description })}
        />

        <section>
          <span className="overline">Ledger</span>
          <div className="ledger-stream">
            {groupSessions(ledger).map((s) => (
              <div key={s.id} className="ledger-item">
                <span className={`av${s.agent ? " av--agent" : ""}`}>
                  {initial(s.agent ?? members.find((m) => m.user_id === s.actorId)?.display_name ?? "?")}
                </span>
                <div className="grow">
                  <Who actorId={s.actorId} agent={s.agent} members={members} />
                  <time>{sessionSpan(s)}</time>
                  {s.lines.length > 1 && (
                    <span className="session-count">{s.lines.length} entries</span>
                  )}
                  {s.lines.map((line) =>
                    line.kind === "comment" ? (
                      <p key={line.id} className="what said">{line.c.body}</p>
                    ) : (
                      <p key={line.id} className="what">{describe(line.a)}</p>
                    ),
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
