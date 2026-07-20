import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  getActiveSlug,
  navigateToOnboarding,
  navigateToWorkspace,
  type Workspace as Ws,
} from "../lib/workspace";

// Dropdown at the top of the sidebar showing the active workspace and letting
// members jump between the workspaces they belong to (or start creating a
// new one via /onboarding). Hosted-only.
export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<Ws[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = getActiveSlug();
  const current = workspaces.find((w) => w.slug === active);

  useEffect(() => {
    void supabase().rpc("my_workspaces").then(({ data, error }) => {
      if (!error && data) setWorkspaces(data as Ws[]);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", marginBottom: 8 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%", textAlign: "left", display: "flex",
          alignItems: "center", justifyContent: "space-between",
        }}
      >
        <span>
          <span className="mono">◆</span>{" "}
          {current?.name ?? (active ?? "No workspace")}
        </span>
        <span className="mono" style={{ opacity: 0.5 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute", top: "100%", left: 0, right: 0,
            marginTop: 4, background: "var(--surface, #1a1a1a)",
            border: "1px solid var(--border, #333)", borderRadius: 4,
            padding: 4, zIndex: 10,
          }}
        >
          {workspaces.map((w) => (
            <button
              key={w.id}
              onClick={() => {
                setOpen(false);
                if (w.slug !== active) navigateToWorkspace(w.slug);
              }}
              style={{ width: "100%", textAlign: "left" }}
              className={w.slug === active ? "active" : ""}
            >
              {w.name} <span className="mono" style={{ opacity: 0.5 }}>{w.slug}</span>
            </button>
          ))}
          <button
            onClick={() => { setOpen(false); navigateToOnboarding(); }}
            style={{ width: "100%", textAlign: "left" }}
          >
            <span className="mono">+</span> New workspace
          </button>
        </div>
      )}
    </div>
  );
}
