// Hosted-only multi-tenancy. The active workspace is the slug in the URL
// path (`/w/{slug}/…`); the Supabase client wrapper reads it via
// getActiveSlug() and injects an `x-workspace-slug` header on every request.
// Postgres `current_workspace_id()` resolves that back to a workspace and
// gates all RLS. If the slug is missing or the caller isn't a member of it,
// current_workspace_id() returns null → policies deny everything (safe).

export interface Workspace {
  id: string;
  slug: string;
  name: string;
}

export interface PendingInvite {
  workspace_id: string;
  slug: string;
  name: string;
}

export function getActiveSlug(): string | null {
  const m = typeof window === "undefined"
    ? null
    : window.location.pathname.match(/^\/w\/([a-z0-9-]+)/);
  return m ? m[1] : null;
}

export function navigateToWorkspace(slug: string) {
  const path = `/w/${slug}`;
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigateToOnboarding() {
  const path = "/onboarding";
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function onPathChange(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
}
