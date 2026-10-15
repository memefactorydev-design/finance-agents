"use client";

import * as React from "react";
import { toast } from "sonner";
import { StepHeader, Grid, SecretField, SelectField, TextField, TestButton, TestResult, SaveBar, saveStep, useDraft, type StepProps } from "../fields";

// The model that reads supplier invoices and order acknowledgements out of
// PDFs and email bodies. One key is enough; the other is optional.
export function AiStep({ connections, reload, next }: StepProps) {
  const a = connections.ai;
  const { draft, set, dirty, setDirty } = useDraft({ anthropicApiKey: a.anthropicApiKey, openaiApiKey: a.openaiApiKey, extractor: a.extractor, model: a.model }, [connections]);
  const [saving, setSaving] = React.useState(false);
  const [test, setTest] = React.useState<Record<string, unknown> | null>(null);
  const save = async () => {
    setSaving(true);
    try { await saveStep("ai", { ai: { anthropicApiKey: draft.anthropicApiKey, openaiApiKey: draft.openaiApiKey, extractor: draft.extractor, model: draft.model.trim() } }); toast.success("AI settings saved"); setDirty(false); await reload(); return true; }
    catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); return false; } finally { setSaving(false); }
  };
  return (
    <div className="space-y-5">
      <StepHeader title="AI extraction" intro="Invoice and acknowledgement extraction runs on a model of your choice. The agents themselves run in Claude Code with their own subscription; this key is only for extraction inside the app." />
      <Grid>
        <SecretField label="Anthropic API key" env="ANTHROPIC_API_KEY" value={draft.anthropicApiKey} onChange={(v) => set("anthropicApiKey", v)} placeholder="sk-ant-…" />
        <SecretField label="OpenAI API key (optional)" env="OPENAI_API_KEY" value={draft.openaiApiKey} onChange={(v) => set("openaiApiKey", v)} placeholder="sk-…" />
        <SelectField label="Extractor" env="FINANCE_EXTRACTOR" value={draft.extractor} onChange={(v) => set("extractor", v)} options={[{ value: "anthropic", label: "Anthropic (Claude)" }, { value: "openai", label: "OpenAI" }]} />
        <TextField label="Model (optional)" hint="Leave blank for the extractor's default. Scanned PDFs are read from page images, so pick a vision-capable model." env="FINANCE_EXTRACT_MODEL" value={draft.model} onChange={(v) => set("model", v)} placeholder="default" mono />
      </Grid>
      <div className="flex flex-wrap items-center gap-2"><TestButton what="ai" label="Test key" onResult={setTest} disabled={dirty} /><span className="text-[11px] text-muted-foreground">{dirty ? "Save first, then test." : "Lists models with the stored key."}</span></div>
      <TestResult result={test} />
      <SaveBar onSave={save} saving={saving} dirty={dirty} onNext={async () => { if (!dirty || (await save())) next(); }} />
    </div>
  );
}
