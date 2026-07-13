// The demo feature: everything AI agents did in the workspace, grouped by day.
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Member, Project } from "../lib/types";

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
      <h2>🤖 Agent activity</h2>
      {items.length === 0 && <p>No agent activity yet. Connect an MCP client and let it work.</p>}
      {Object.entries(byDay).map(([day, dayItems]) => (
        <section key={day}>
          <h3>{day}</h3>
          <ul>
            {dayItems.map((a) => {
              const human = members.find((m) => m.user_id === a.actor_id)?.display_name;
              const key = projects.find((p) => p.id === a.issue.project_id)?.key ?? "?";
              return (
                <li key={a.id}>
                  <strong>{a.agent_name}</strong> {human && <small>(for {human})</small>}{" "}
                  {a.action === "created"
                    ? `created ${key}-${a.issue.number}: ${a.issue.title}`
                    : `changed ${a.action} on ${key}-${a.issue.number}: ${a.old_value ?? "—"} → ${a.new_value ?? "—"}`}
                  <time>{new Date(a.created_at).toLocaleTimeString()}</time>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
