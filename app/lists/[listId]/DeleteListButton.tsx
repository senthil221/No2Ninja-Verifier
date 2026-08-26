"use client";

import { useState } from "react";
import { removeList } from "@/app/actions";

export default function DeleteListButton({
  listId,
  listName,
  totalRows,
}: {
  listId: string;
  listName: string;
  totalRows: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!confirming) {
    return (
      <button className="btn-danger-ghost" onClick={() => setConfirming(true)}>
        Delete list
      </button>
    );
  }

  return (
    <div className="confirm-box">
      <strong>Delete “{listName}”?</strong>
      <div className="meta" style={{ marginTop: 4 }}>
        Permanently removes {totalRows} prospect {totalRows === 1 ? "row" : "rows"} and their
        verification results. Export first if you still need the data — this can't be undone.
        Credits already spent stay on your spend history.
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button
          className="btn-danger"
          disabled={deleting}
          onClick={async () => {
            setDeleting(true);
            await removeList(listId);
          }}
        >
          {deleting ? "Deleting…" : "Yes, delete permanently"}
        </button>
        <button className="btn-quiet" disabled={deleting} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
