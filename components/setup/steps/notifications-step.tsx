"use client";

import * as React from "react";
import { toast } from "sonner";
import { StepHeader, SecretField, SaveBar, saveStep, useDraft, type StepProps } from "../fields";

// Optional Slack mirror: every brief the agents post to the in-app channel is
// also sent to an incoming webhook. Replies still happen in the app.
export function NotificationsStep({ connections, reload, next }: StepProps) {
  const { draft, set, dirty, setDirty } = useDraft({ slackWebhookUrl: connections.notify.slackWebhookUrl }, [connections]);
  const [saving, setSaving] = React.useState(false);
  const save = async () => {
    setSaving(true);
    try { await saveStep("notifications", { notify: { slackWebhookUrl: draft.slackWebhookUrl.trim() } }); toast.success("Notifications saved"); setDirty(false); await reload(); return true; }
    catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); return false; } finally { setSaving(false); }
  };
  return (
    <div className="space-y-5">
      <StepHeader title="Notifications" intro="Optional. Mirror the briefs channel to Slack so the 18:00 money report, approval requests and hand-offs land where you already look. Leave blank to keep everything in the app." />
      <SecretField label="Slack incoming webhook URL" hint="Slack → Apps → Incoming Webhooks → pick the channel. Posts are one-way; reply in the Briefs page." env="SLACK_WEBHOOK_URL" value={draft.slackWebhookUrl} onChange={(v) => set("slackWebhookUrl", v)} placeholder="https://hooks.slack.com/services/…" />
      <SaveBar onSave={save} saving={saving} dirty={dirty} onNext={async () => { if (!dirty || (await save())) next(); }} />
    </div>
  );
}
