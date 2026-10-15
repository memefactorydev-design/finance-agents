"use client";

import * as React from "react";
import Link from "next/link";
import { UserRound, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/components/use-api";
import { Field, Grid, StepHeader, type StepProps } from "../fields";

// Creates the single owner login (before any session exists) or, for the
// signed-in owner, changes name / email / password.
export function OwnerStep({ state, user, reload, next }: StepProps) {
  const [name, setName] = React.useState(user?.name || "");
  const [email, setEmail] = React.useState(user?.id || "");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const creating = !state.ownerSet;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { toast.error("Password must be at least 8 characters"); return; }
    if (password !== confirm) { toast.error("Passwords do not match"); return; }
    setBusy(true);
    try {
      await api("/api/setup", { method: "POST", json: { owner: { email: email.trim(), name: name.trim(), password } } });
      toast.success(creating ? "Owner created — you are signed in" : "Owner updated");
      setPassword(""); setConfirm("");
      await reload();
      if (creating) next();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not save the owner"); } finally { setBusy(false); }
  };
  if (state.ownerSet && !user) {
    return (
      <div>
        <StepHeader title="Owner" intro="An owner login already exists for this install." />
        <p className="text-sm">Sign in to continue with setup. <Link className="text-primary underline" href="/login?next=/setup">Sign in</Link></p>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <StepHeader title={creating ? "Create the owner login" : "Owner"} intro={creating ? "Single-owner app: the person who runs setup is the admin. Agents get their own API keys in the last step." : `Signed in as ${user?.name || user?.id}. Change the name, email or password here.`} />
      <Grid>
        <Field label="Name"><Input className="h-9" value={name} onChange={(e) => setName(e.target.value)} required autoFocus={creating} /></Field>
        <Field label="Email" hint="Used to sign in and as the default approver."><Input className="h-9" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label={creating ? "Password" : "New password"} hint="At least 8 characters."><Input className="h-9" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" /></Field>
        <Field label="Confirm password"><Input className="h-9" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" /></Field>
      </Grid>
      <div className="flex justify-end gap-2 border-t pt-4">
        {!creating ? <Button type="button" variant="outline" onClick={next}>Continue</Button> : null}
        <Button type="submit" disabled={busy || !state.appSecret} className="gap-1.5">{creating ? <UserRound className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />} {busy ? "Saving…" : creating ? "Create owner and continue" : "Update owner"}</Button>
      </div>
    </form>
  );
}
