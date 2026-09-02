import { AlertCircleIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import type { DailyPulseResponse } from "@/api/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface BlockedAgent {
  reportId: string;
  developerName: string;
  connectionLabel: string;
  agentName: string;
  client: string;
  blockerReason: string;
  filesTouched: string[];
  status: "online" | "idle" | "offline";
}

export function BlockerRadar({ pulse, canEdit, onResolve }: {
  pulse: DailyPulseResponse;
  canEdit: boolean;
  onResolve: (reportId: string, note: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<{ reportId: string; agentName: string } | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blockedAgents: BlockedAgent[] = [];

  for (const dev of pulse.developers) {
    for (const conn of dev.connections) {
      for (const agent of conn.agents) {
        if (agent.latest_progress?.state === "blocked" && agent.latest_progress.resolved_at === null) {
          blockedAgents.push({
            reportId: agent.latest_progress.id,
            developerName: dev.display_name,
            connectionLabel: conn.label,
            agentName: agent.name,
            client: agent.client,
            blockerReason: agent.latest_progress.blocker_reason ?? "Blocker flagged without details",
            filesTouched: agent.latest_progress.files_touched,
            status: agent.status,
          });
        }
      }
    }
  }

  if (blockedAgents.length === 0) return null;

  const submitResolution = async () => {
    if (selected === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await onResolve(selected.reportId, note);
      setSelected(null);
      setNote("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to resolve blocker");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Alert variant="destructive" className="min-w-0 overflow-hidden border-red-500/30 bg-red-500/10 text-red-950 dark:text-red-200">
      <ShieldAlertIcon className="size-5 text-red-600 dark:text-red-400 mt-0.5" />
      <AlertTitle className="font-semibold text-sm flex items-center gap-2">
        <span>Blocker Radar: {blockedAgents.length} active blocker{blockedAgents.length > 1 ? "s" : ""} require attention</span>
      </AlertTitle>
      <AlertDescription className="mt-2 space-y-3">
        {blockedAgents.map((blocker) => (
          <div key={blocker.reportId} className="min-w-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-md bg-background/60 border border-red-500/20 text-foreground text-xs">
            <div className="min-w-0 space-y-1">
              <div className="min-w-0 flex items-center gap-2 flex-wrap">
                <span className="min-w-0 break-anywhere font-medium text-red-600 dark:text-red-400 flex items-center gap-1 flex-wrap">
                  <AlertCircleIcon className="size-3.5" />
                  {blocker.agentName} ({blocker.client})
                </span>
                <span className="break-anywhere text-muted-foreground">• {blocker.developerName} ({blocker.connectionLabel})</span>
                <Badge variant="destructive" className="text-[10px] h-4 py-0">Blocked</Badge>
              </div>
              <p className="break-anywhere font-mono text-xs text-red-900 dark:text-red-300 font-medium">
                &ldquo;{blocker.blockerReason}&rdquo;
              </p>
            </div>
            <div className="min-w-0 flex items-center gap-2 flex-wrap justify-end">
              {blocker.filesTouched.length > 0 ? (
                <div className="min-w-0 flex items-center gap-1 flex-wrap text-[11px] text-muted-foreground">
                  <span className="break-anywhere font-mono">{blocker.filesTouched.slice(0, 2).join(", ")}</span>
                  {blocker.filesTouched.length > 2 && <span>+{blocker.filesTouched.length - 2} more</span>}
                </div>
              ) : null}
              {canEdit && blocker.status === "offline" ? (
                <Button variant="outline" size="sm" aria-label={`Resolve blocker for ${blocker.agentName}`} onClick={() => {
                  setSelected({ reportId: blocker.reportId, agentName: blocker.agentName });
                  setNote("");
                  setError(null);
                }}>
                  Mark resolved
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </AlertDescription>
      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open && !submitting) setSelected(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve blocker?</DialogTitle>
            <DialogDescription>
              This keeps the original report in history and marks the offline agent&apos;s blocker as resolved.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pulse-resolution-note">Resolution note (optional)</Label>
            <Textarea id="pulse-resolution-note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What resolved this blocker?" />
            {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)} disabled={submitting}>Cancel</Button>
            <Button onClick={() => void submitResolution()} disabled={submitting}>
              {submitting ? "Resolving…" : "Mark resolved"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Alert>
  );
}
