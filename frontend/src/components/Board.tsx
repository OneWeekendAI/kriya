import { useState } from "react";
import * as api from "../lib/api";
import type { Issue, IssueStatus, Project } from "../lib/types";
import { STATUSES } from "../lib/types";

const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  done: "Done",
  cancelled: "Cancelled",
};

export function Board({
  project,
  issues,
  onSelect,
  onChanged,
}: {
  project: Project;
  issues: Issue[];
  onSelect: (issue: Issue) => void;
  onChanged: () => void;
}) {
  const [quickTitle, setQuickTitle] = useState("");

  async function quickCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!quickTitle.trim()) return;
    await api.createIssue(project.id, { title: quickTitle.trim(), status: "todo" });
    setQuickTitle("");
    onChanged();
  }

  return (
    <div className="board-wrap">
      <form className="quick-create" onSubmit={quickCreate}>
        <input
          placeholder={`New issue in ${project.key}…`}
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
        />
      </form>
      <div className="board">
        {STATUSES.map((status) => (
          <section
            key={status}
            className="column"
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              const id = e.dataTransfer.getData("issue-id");
              if (id) {
                await api.updateIssue(id, { status });
                onChanged();
              }
            }}
          >
            <h2>{STATUS_LABEL[status]}</h2>
            {issues
              .filter((i) => i.status === status)
              .map((issue) => (
                <article
                  key={issue.id}
                  className="card"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("issue-id", issue.id)}
                  onClick={() => onSelect(issue)}
                >
                  <span className="issue-id">{project.key}-{issue.number}</span>
                  {issue.created_by_agent && <span className="agent-badge" title={`Created by ${issue.created_by_agent}`}>🤖</span>}
                  <p>{issue.title}</p>
                  {issue.priority !== "none" && <span className={`priority ${issue.priority}`}>{issue.priority}</span>}
                </article>
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}
