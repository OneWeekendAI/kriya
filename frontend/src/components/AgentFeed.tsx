// The demo feature: everything AI agents did in the workspace, grouped by day.
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Member, Project } from "../lib/types";
import { initial } from "./Entry";

type FeedItem = Awaited<ReturnType<typeof api.listAgentActivity>>[number];

export function AgentFeed({ members, projects }: { members: Member[]; projects: Project[] }) {
  const [items, setItems] = useState<FeedItem[]>([]);

  useEffect(() => {
    void api.listAgentActivity().then(setItems);
  }, []);

  const byDay = items.reduce<Record<string, FeedItem[]>>((acc, item) => {
    const day = new Date(item.created_at).toDateString();
    (acc[day] ??= []).push(item);
    return acc;
  }, {});

  return (
    <div className="agent-feed">
      {items.length === 0 && (
        <p className="empty-note">
          No agent entries yet. Connect an MCP client and let it work — every action lands here, signed with who it acted for.
        </p>
      )}
      {Object.entries(byDay).map(([day, dayItems]) => (
        <section key={day} className="day">
          <h3>{day} — {dayItems.length} entr{dayItems.length === 1 ? "y" : "ies"}</h3>
          <div className="ledger-stream">
            {dayItems.map((a) => {
              const human = members.find((m) => m.user_id === a.actor_id)?.display_name;
              const key = projects.find((p) => p.id === a.issue.project_id)?.key ?? "?";
              return (
                <div key={a.id} className="ledger-item">
                  <span className="av av--agent">{initial(a.agent_name ?? "?")}</span>
                  <div className="grow">
                    <span className="who">
                      <strong className="agent-mark">{a.agent_name}</strong>
                      {human && <span className="for"> for {human}</span>}
                      <time>{new Date(a.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                    </span>
                    <p className="what">
                      {a.action === "created"
                        ? `created ${key}-${a.issue.number}: ${a.issue.title}`
                        : `${a.action} on ${key}-${a.issue.number}: ${a.old_value ?? "—"} → ${a.new_value ?? "—"}`}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
