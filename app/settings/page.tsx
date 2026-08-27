import { config } from "@/lib/config";
import { requireUser } from "@/lib/require-user";

export const dynamic = "force-dynamic";

function mask(key: string) {
  if (!key) return "(not set)";
  return key.length <= 6 ? "*".repeat(key.length) : `${key.slice(0, 3)}...${key.slice(-3)}`;
}

export default function SettingsPage() {
  return (
    <>
      <span className="eyebrow">Configuration</span>
      <h1>Settings</h1>
      <p className="subtitle">
        Configured via environment variables. Edit your <code>.env</code> and restart the app +
        worker to change these.
      </p>

      <div className="card">
        <h2>Mail Tester Ninja</h2>
        <div className="kv-row">
          <span className="k">API key</span>
          <code>{mask(config.mtn.apiKey)}</code>
        </div>
        <div className="kv-row">
          <span className="k">Rate limit</span>
          <code>
            {config.mtn.rateLimitMax} / {config.mtn.rateLimitWindowMs}ms
          </code>
        </div>
        <div className="kv-row">
          <span className="k">Max retries on transient errors</span>
          <code>{config.mtn.maxRetries}</code>
        </div>
      </div>

      <div className="card">
        <h2>NeverBounce (no2bounce)</h2>
        <div className="kv-row">
          <span className="k">API token</span>
          <code>{mask(config.n2b.apiToken)}</code>
        </div>
        <div className="kv-row">
          <span className="k">Poll interval</span>
          <code>{config.n2b.pollIntervalMs}ms</code>
        </div>
        <div className="kv-row">
          <span className="k">Pause for approval before spending</span>
          <code>{config.n2b.requireApproval ? "yes — every list" : "only over the cap"}</code>
        </div>
        <div className="kv-row">
          <span className="k">Single-list credit cap</span>
          <code>{config.n2b.singleListCreditCap}</code>
        </div>
      </div>

      <div className="card">
        <h2>Alerting</h2>
        <div className="kv-row">
          <span className="k">Webhook</span>
          <code>{config.alertWebhookUrl ? "configured" : "not set — alerts disabled"}</code>
        </div>
        <div className="kv-row">
          <span className="k">Events sent</span>
          <code>list_failed · needs_decision · list_completed</code>
        </div>
      </div>

      <div className="card">
        <h2>Pipeline behavior</h2>
        <div className="kv-row">
          <span className="k">Sent on to NeverBounce</span>
          <code>
            {config.mtnEscalationPolicy === "all_except_valid"
              ? "everything except confirmed valid"
              : "only rows MTN couldn't answer"}
          </code>
        </div>
        <div className="kv-row">
          <span className="k">Catch-all handling</span>
          <code>{config.catchAllHandling}</code>
        </div>
        <div className="kv-row">
          <span className="k">Email cache freshness</span>
          <code>{config.emailCacheTtlDays} days</code>
        </div>
      </div>
    </>
  );
}
