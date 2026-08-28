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
        <h2>No2Bounce</h2>
        <div className="kv-row">
          <span className="k">API token</span>
          <code>{mask(config.n2b.apiToken)}</code>
        </div>
        <div className="kv-row">
          <span className="k">Poll interval</span>
          <code>{config.n2b.pollIntervalMs}ms</code>
        </div>
      </div>

      <div className="card">
        <h2>Alerting</h2>
        <div className="kv-row">
          <span className="k">Webhook</span>
          <code>{config.alertWebhookUrl ? "configured" : "not set, alerts disabled"}</code>
        </div>
        <div className="kv-row">
          <span className="k">Events sent</span>
          <code>list_failed · list_completed · provider_unavailable</code>
        </div>
      </div>

      <div className="card">
        <h2>Pipeline behavior</h2>
        <div className="kv-row">
          <span className="k">Sent on to No2Bounce</span>
          <code>catch-all, SPAM block, timeout, MX error, limited</code>
        </div>
        <div className="kv-row">
          <span className="k">Settled by Mail Tester Ninja alone</span>
          <code>accepted &rarr; valid · rejected, no MX &rarr; invalid</code>
        </div>
        <div className="kv-row">
          <span className="k">Counted valid from No2Bounce</span>
          <code>deliverable only &mdash; not catch-all, spam, bounce or invalid</code>
        </div>
        <div className="kv-row">
          <span className="k">Catch-all handling</span>
          <code>{config.catchAllHandling}</code>
        </div>
        <div className="kv-row">
          <span className="k">Reuse Mail Tester Ninja results</span>
          <code>
            {config.mtnCacheTtlDays > 0
              ? `${config.mtnCacheTtlDays} days`
              : "never, always re-verify"}
          </code>
        </div>
        <div className="kv-row">
          <span className="k">Reuse No2Bounce results</span>
          <code>
            {config.n2bCacheTtlDays > 0
              ? `${config.n2bCacheTtlDays} days`
              : "never, re-charges every time"}
          </code>
        </div>
        <div className="kv-row">
          <span className="k">Reuse confirmed catch-all domains</span>
          <code>{config.domainCacheTtlDays} days</code>
        </div>
      </div>
    </>
  );
}
