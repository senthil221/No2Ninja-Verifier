import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

function mask(key: string) {
  if (!key) return "(not set)";
  return key.length <= 6 ? "*".repeat(key.length) : `${key.slice(0, 3)}...${key.slice(-3)}`;
}

export default function SettingsPage() {
  return (
    <>
      <h1>Settings</h1>
      <p className="subtitle">
        Configured via environment variables. Edit your <code>.env</code> and restart the app +
        worker to change these.
      </p>

      <div className="panel">
        <h2>Mail Tester Ninja</h2>
        <div className="field">
          API key: <code>{mask(config.mtn.apiKey)}</code>
        </div>
        <div className="field">
          Rate limit: <code>{config.mtn.rateLimitMax}</code> requests /{" "}
          <code>{config.mtn.rateLimitWindowMs}ms</code>
        </div>
        <div className="field">
          Max retries on transient errors: <code>{config.mtn.maxRetries}</code>
        </div>
      </div>

      <div className="panel">
        <h2>NeverBounce (no2bounce)</h2>
        <div className="field">
          API token: <code>{mask(config.n2b.apiToken)}</code>
        </div>
        <div className="field">
          Poll interval: <code>{config.n2b.pollIntervalMs}ms</code>
        </div>
        <div className="field">
          Single-list credit cap (requires manual approval above this):{" "}
          <code>{config.n2b.singleListCreditCap}</code>
        </div>
      </div>

      <div className="panel">
        <h2>Pipeline behavior</h2>
        <div className="field">
          Catch-all handling: <code>{config.catchAllHandling}</code>
        </div>
        <div className="field">
          Email cache freshness: <code>{config.emailCacheTtlDays} days</code>
        </div>
      </div>
    </>
  );
}
