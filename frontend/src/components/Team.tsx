import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Member } from "../lib/types";

/** Everyone in the workspace, plus invites that haven't been redeemed yet. */
export function Team({ members, currentUserId, onInvite }: {
  members: Member[];
  currentUserId: string;
  onInvite: () => void;
}) {
  const [pending, setPending] = useState<{ email: string; created_at: string }[]>([]);

  useEffect(() => {
    api.listPendingInvites().then(setPending).catch(() => setPending([]));
  }, [members]);

  return (
    <div className="team">
      <h2>Team</h2>
      <ul className="member-list">
        {members.map((m) => (
          <li key={m.user_id}>
            <strong>{m.display_name}</strong>
            {m.user_id === currentUserId && " (you)"}
            <span className="muted"> — {m.email}</span>
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
              </li>
            ))}
          </ul>
        </>
      )}

      <button onClick={onInvite}>Invite teammate</button>
    </div>
  );
}
