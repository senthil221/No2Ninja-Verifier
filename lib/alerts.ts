import { config } from "./config";

export type AlertEvent =
  | {
      type: "list_failed";
      listId: string;
      listName: string;
      clientName: string;
      error: string;
    }
  | {
      type: "needs_decision";
      listId: string;
      listName: string;
      clientName: string;
      resolved: number;
      totalRows: number;
      creditsRequired: number;
    }
  | {
      type: "list_completed";
      listId: string;
      listName: string;
      clientName: string;
      totalRows: number;
      valid: number;
      creditsSpent: number;
    }
  | {
      type: "provider_unavailable";
      provider: "mtn" | "n2b";
      detail: string;
    };

const SUMMARY: Record<AlertEvent["type"], string> = {
  list_failed: "A list stopped before finishing",
  needs_decision: "A list is waiting on your approval to spend credits",
  list_completed: "A list finished verifying",
  provider_unavailable: "A verification provider is not responding",
};

// Fire-and-forget. Alerting exists to tell you the pipeline had a problem --
// it must never become the problem, so a broken or slow webhook is logged
// and swallowed rather than failing the job that triggered it.
export async function sendAlert(event: AlertEvent): Promise<void> {
  const url = config.alertWebhookUrl;
  if (!url) return;

  const payload = {
    summary: SUMMARY[event.type],
    event: event.type,
    at: new Date().toISOString(),
    app: config.publicUrl || undefined,
    // A direct link is the difference between an alert you act on and one
    // you have to go hunting for.
    link:
      "listId" in event && config.publicUrl
        ? `${config.publicUrl.replace(/\/$/, "")}/lists/${event.listId}`
        : undefined,
    ...event,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[alert] webhook returned ${res.status} for ${event.type}`);
    }
  } catch (err) {
    console.error(`[alert] could not deliver ${event.type}:`, (err as Error).message);
  }
}
