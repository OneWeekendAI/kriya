import { useEffect, useState } from "react";
import type { Issue, IssueStatus, Member, Project } from "../lib/types";
import { STATUSES } from "../lib/types";
import * as api from "../lib/api";
import { Entry } from "./Entry";
import { IssuePanel } from "./IssuePanel";

const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Void",
};

export function SplitBoard({
  project,
  issues,
  members,
  selected,
  onSelect,
  onChanged,
}: {
  project: Project;
  issues: Issue[];
  members: Member[];
  selected: Issue | null;
  onSelect: (issue: Issue | null) => void;
  onChanged: () => void;
}) {
  const [selectedStatus, setSelectedStatus] = useState<IssueStatus>("todo");
  const [searchQuery, setSearchQuery] = useState("");
  const [quickTitle, setQuickTitle] = useState("");

  const statusCounts = STATUSES.reduce<Record<IssueStatus, number>>((acc, s) => {
    acc[s] = issues.filter((i) => i.status === s).length;
    return acc;
  }, {} as Record<IssueStatus, number>);

  const filteredIssues = issues
    .filter((i) => i.status === selectedStatus)
    .filter((i) =>
      i.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (i.description ?? "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      `${project.key}-${i.number}`.toLowerCase().includes(searchQuery.toLowerCase())
    );

  // Auto-select the first issue in the filtered list if none is selected
  useEffect(() => {
    if (!selected && filteredIssues.length > 0) {
      onSelect(filteredIssues[0]);
    }
  }, [selected, filteredIssues, onSelect]);

  async function handleQuickCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!quickTitle.trim()) return;
    await api.createIssue(project.id, {
      title: quickTitle.trim(),
      status: selectedStatus,
    });
    setQuickTitle("");
    onChanged();
  }

  return (
    <div className="split-view">
      {/* Column 1: Statuses list */}
      <div className="split-col split-col--status">
        <span className="overline" style={{ marginBottom: 12 }}>Workflow</span>
        <div className="status-list">
          {STATUSES.map((status) => (
            <button
              key={status}
              className={`status-item ${selectedStatus === status ? "active" : ""}`}
              onClick={() => {
                setSelectedStatus(status);
                // When status changes, keep the selected issue if it matches the status,
                // or deselect it if it doesn't match the new status column.
                if (selected && selected.status !== status) {
                  onSelect(null);
                }
              }}
            >
              <span className="status-name">{STATUS_LABEL[status]}</span>
              <span className="status-badge">{statusCounts[status]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Column 2: Issues List */}
      <div className="split-col split-col--issues">
        <span className="overline" style={{ marginBottom: 12 }}>Ledger Entries</span>
        <div className="search-box">
          <input
            type="text"
            placeholder="Search current list…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <form className="quick-create-split" onSubmit={handleQuickCreate}>
          <input
            placeholder={`Log a new ${STATUS_LABEL[selectedStatus].toLowerCase()} entry…`}
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
          />
        </form>

        <div className="split-issue-list">
          {filteredIssues.length === 0 ? (
            <p className="empty-note" style={{ padding: "20px 10px" }}>
              No {STATUS_LABEL[selectedStatus].toLowerCase()} entries found.
            </p>
          ) : (
            filteredIssues.map((issue) => (
              <Entry
                key={issue.id}
                issue={issue}
                project={project}
                members={members}
                onSelect={onSelect}
                active={selected?.id === issue.id}
              />
            ))
          )}
        </div>
      </div>

      {/* Column 3: Issue Details */}
      <div className="split-col split-col--details">
        {selected ? (
          <IssuePanel
            issue={selected}
            project={project}
            members={members}
            onClose={() => onSelect(null)}
            onChanged={onChanged}
            inline
          />
        ) : (
          <div className="split-empty-details">
            <span className="overline">LEDGER DETAILED VIEW</span>
            <h3>No Kriya Selected</h3>
            <p>
              Select an entry from the ledger column to view its active history, assignments, comments, and agent logs.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
