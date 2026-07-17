import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Member } from "../lib/types";

/** Everyone in the workspace, plus invites that haven't been redeemed yet. */
export function Team({ members, currentUserId, onInvite, onRemoved }: {
  members: Member[];
  currentUserId: string;
  onInvite: () => void;
  onRemoved: () => void;
}) {
  const [pending, setPending] = useState<{ email: string; created_at: string }[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshPending = () =>
    api.listPendingInvites().then(setPending).catch(() => setPending([]));

  useEffect(() => {
    void refreshPending();
  }, [members]);

  async function remove(userId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.removeMember(userId);
      setConfirming(null);
      onRemoved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(email: string) {
    setError(null);
    try {
      await api.revokeInvite(email);
      await refreshPending();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="team">
      <h2>Team</h2>
      {error && <p className="error">{error}</p>}
      <ul className="member-list">
        {members.map((m) => (
          <li key={m.user_id}>
            <strong>{m.display_name}</strong>
            {m.user_id === currentUserId && " (you)"}
            <span className="muted"> — {m.email}</span>
            {m.user_id !== currentUserId && (
              confirming === m.user_id ? (
                <>
                  {" "}
                  <button className="link" disabled={busy} onClick={() => remove(m.user_id)}>
                    {busy ? "Removing…" : `Yes, remove ${m.display_name}`}
                  </button>
                  <button className="link" disabled={busy} onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {" "}
                  <button className="link" onClick={() => { setConfirming(m.user_id); setError(null); }}>
                    Remove
                  </button>
                </>
              )
            )}
          </li>
        ))}
      </ul>

      {pending.length > 0 && (
        <>
          <h3>Invited — hasn't joined yet</h3>
          <ul className="member-list">
            {pending.map((i) => (
              <li key={i.email}>
                {i.email}
                <span className="muted"> — invited {new Date(i.created_at).toLocaleDateString()}</span>
                {" "}
                <button className="link" onClick={() => revoke(i.email)}>Revoke</button>
              </li>
            ))}
          </ul>
        </>
      )}

      <button onClick={onInvite}>Invite teammate</button>
    </div>
  );
}
