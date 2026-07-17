// Bento home: the board at a glance plus the day's ledger — how many kriyas
// were logged, how many by agents, and who (human or machine) is around.
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Issue, IssueStatus, Member, Project } from "../lib/types";
import { Entry, initial } from "./Entry";

type AgentItem = Awaited<ReturnType<typeof api.listAgentActivity>>[number];

const BOARD_COLS: { status: IssueStatus; label: string }[] = [
  { status: "todo", label: "Todo" },
  { status: "in_progress", label: "In progress" },
  { status: "done", label: "Done" },
];

const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function BentoBoard({
  project,
  issues,
  members,
  onSelect,
  onOpenBoard,
}: {
  project: Project;
  issues: Issue[];
  members: Member[];
  onSelect: (issue: Issue) => void;
  onOpenBoard: () => void;
}) {
  const [agentItems, setAgentItems] = useState<AgentItem[]>([]);

  useEffect(() => {
    void api.listAgentActivity(50).then(setAgentItems);
    return api.onWorkspaceChange(() => void api.listAgentActivity(50).then(setAgentItems));
  }, []);

  const projectAgentItems = agentItems.filter((a) => a.issue.project_id === project.id);
  const agentToday = projectAgentItems.filter((a) => isToday(a.created_at));
  const issuesToday = issues.filter((i) => isToday(i.updated_at));
  const agentNames = [...new Set(projectAgentItems.map((a) => a.agent_name!))];

  const agentTally =
    agentToday.length === 0
      ? "quiet so far today"
      : Object.entries(
          agentToday.reduce<Record<string, number>>((acc, a) => {
            acc[a.agent_name!] = (acc[a.agent_name!] ?? 0) + 1;
            return acc;
          }, {}),
        )
          .map(([name, n]) => `${n} by ${name}`)
          .join(" · ");

  return (
    <div className="bento">
      <div className="tile tile--board">
        <span className="overline">Board</span>
        <div className="bento-cols">
          {BOARD_COLS.map(({ status, label }) => {
            const col = issues.filter((i) => i.status === status);
            return (
              <div key={status}>
                <div className="bento-col-head">
                  {label} — {col.length}
                </div>
                {col.slice(0, 3).map((issue) => (
                  <Entry key={issue.id} issue={issue} project={project} members={members} onSelect={onSelect} />
                ))}
                {col.length > 3 && (
                  <button className="link" style={{ fontSize: "0.74rem" }} onClick={onOpenBoard}>
                    +{col.length - 3} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="tile-stack">
        <div className="tile tile--stat">
          <span className="overline">Today</span>
          <span className="big">{issuesToday.length}</span>
          <span className="sub">issue{issuesToday.length === 1 ? "" : "s"} touched</span>
        </div>
        <div className="tile tile--stat">
          <span className="overline agent-mark">By agents</span>
          <span className="big agent-mark">{agentToday.length}</span>
          <span className="sub">{agentTally}</span>
        </div>
      </div>

      <div className="tile tile--ledger">
        <span className="overline">Agent ledger</span>
        {projectAgentItems.length === 0 && (
          <p className="empty-note">No agent entries yet. Connect an MCP client and let it work — every action lands here, signed.</p>
        )}
        <div className="ledger-stream">
          {projectAgentItems.slice(0, 4).map((a) => {
            const human = members.find((m) => m.user_id === a.actor_id)?.display_name;
            return (
              <div key={a.id} className="ledger-item">
                <span className="av av--agent">{initial(a.agent_name!)}</span>
                <div className="grow">
                  <span className="who">
                    <strong>{a.agent_name}</strong>
                    {human && <span className="for"> for {human}</span>}
                    <time>{clock(a.created_at)}</time>
                  </span>
                  <p className="what">
                    {a.action === "created"
                      ? `created ${project.key}-${a.issue.number}: ${a.issue.title}`
                      : `${a.action}: ${a.old_value ?? "—"} → ${a.new_value ?? "—"} on ${project.key}-${a.issue.number}`}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="tile">
        <span className="overline">Team</span>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {members.map((m) => (
            <span key={m.user_id} className="av av--lg" title={m.display_name}>
              {initial(m.display_name)}
            </span>
          ))}
          {agentNames.map((name) => (
            <span key={name} className="av av--lg av--agent" title={name}>
              {initial(name)}
            </span>
          ))}
        </div>
        <p className="sub muted" style={{ fontSize: "0.78rem", marginTop: 10 }}>
          {members.length} human{members.length === 1 ? "" : "s"} · {agentNames.length} agent
          {agentNames.length === 1 ? "" : "s"}
        </p>
      </div>
    </div>
  );
}
