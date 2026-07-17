import { useState } from "react";
import * as api from "../lib/api";
import type { Issue, IssueStatus, Member, Project } from "../lib/types";
import { STATUSES } from "../lib/types";
import { Entry } from "./Entry";

const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
};

export function Board({
  project,
  issues,
  members,
  onSelect,
  onChanged,
}: {
  project: Project;
  issues: Issue[];
  members: Member[];
  onSelect: (issue: Issue) => void;
  onChanged: () => void;
}) {
  const [quickTitle, setQuickTitle] = useState("");
  const [dragOver, setDragOver] = useState<IssueStatus | null>(null);

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
          placeholder={`Write a new entry in ${project.key}…`}
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
        />
      </form>
      <div className="board">
        {STATUSES.map((status) => {
          const col = issues.filter((i) => i.status === status);
          return (
            <section
              key={status}
              className={`column${dragOver === status ? " drag-over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(status); }}
              onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
              onDrop={async (e) => {
                setDragOver(null);
                const id = e.dataTransfer.getData("issue-id");
                if (id) {
                  await api.updateIssue(id, { status });
                  onChanged();
                }
              }}
            >
              <h2>
                {STATUS_LABEL[status]} <span className="count">{col.length}</span>
              </h2>
              {col.map((issue) => (
                <Entry
                  key={issue.id}
                  issue={issue}
                  project={project}
                  members={members}
                  onSelect={onSelect}
                  draggable
                />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
