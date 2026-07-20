import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import {
  getActiveSlug,
  navigateToOnboarding,
  navigateToWorkspace,
  onPathChange,
  type Workspace as Ws,
} from "../lib/workspace";
import { Workspace } from "./Workspace";
import { Onboarding } from "./Onboarding";

// Hosted-only wrapper around Workspace. Resolves the active workspace from
// the URL slug, routes signed-in users with zero workspaces to /onboarding,
// and re-renders when the path changes (browser back/forward or programmatic
// navigateToWorkspace calls).
export function WorkspaceGate({ session }: { session: Session }) {
  const [workspaces, setWorkspaces] = useState<Ws[] | null>(null);
  const [path, setPath] = useState<string>(
    typeof window === "undefined" ? "/" : window.location.pathname,
  );

  const load = useCallback(async () => {
    const { data, error } = await supabase().rpc("my_workspaces");
    if (error) {
      console.error("my_workspaces failed", error);
      setWorkspaces([]);
      return;
    }
    setWorkspaces((data ?? []) as Ws[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Path changes (Onboarding → /w/{slug}, switcher, back/forward) must refresh
  // the workspace list — a workspace we just created won't be in the cached
  // list otherwise, and the gate would keep showing Onboarding.
  useEffect(
    () => onPathChange(() => {
      setPath(window.location.pathname);
      void load();
    }),
    [load],
  );

  if (workspaces === null) return null;

  // Zero workspaces → force onboarding.
  if (workspaces.length === 0) {
    if (path !== "/onboarding") navigateToOnboarding();
    return <Onboarding />;
  }

  const slug = getActiveSlug();
  const active = slug ? workspaces.find((w) => w.slug === slug) : null;

  // Slug missing or unknown → send them into their first workspace.
  if (!active) {
    // If URL is /onboarding, allow it (they may want to create another).
    if (path === "/onboarding") return <Onboarding />;
    navigateToWorkspace(workspaces[0].slug);
    return null;
  }

  // key={slug} forces a full remount when the caller switches workspaces —
  // otherwise Workspace's projects/issues/selected state carries over and
  // shows the previous workspace's data until the next refresh().
  return <Workspace key={active.slug} session={session} />;
}
