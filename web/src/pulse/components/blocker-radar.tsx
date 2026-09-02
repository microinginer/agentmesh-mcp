import { AlertCircleIcon, ShieldAlertIcon } from "lucide-react";

import type { DailyPulseResponse } from "@/api/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export function BlockerRadar({ pulse }: { pulse: DailyPulseResponse }) {
  const blockedAgents: Array<{
    developerName: string;
    connectionLabel: string;
    agentName: string;
    client: string;
    blockerReason: string;
    filesTouched: string[];
    reportedAt: string;
  }> = [];

  for (const dev of pulse.developers) {
    for (const conn of dev.connections) {
      for (const agent of conn.agents) {
        if (agent.latest_progress?.state === "blocked") {
          blockedAgents.push({
            developerName: dev.display_name,
            connectionLabel: conn.label,
            agentName: agent.name,
            client: agent.client,
            blockerReason: agent.latest_progress.blocker_reason ?? "Blocker flagged without details",
            filesTouched: agent.latest_progress.files_touched,
            reportedAt: agent.latest_progress.reported_at,
          });
        }
      }
    }
  }

  if (blockedAgents.length === 0) {
    return null;
  }

  return (
    <Alert variant="destructive" className="min-w-0 overflow-hidden border-red-500/30 bg-red-500/10 text-red-950 dark:text-red-200">
      <ShieldAlertIcon className="size-5 text-red-600 dark:text-red-400 mt-0.5" />
      <AlertTitle className="font-semibold text-sm flex items-center gap-2">
        <span>Blocker Radar: {blockedAgents.length} active blocker{blockedAgents.length > 1 ? "s" : ""} require attention</span>
      </AlertTitle>
      <AlertDescription className="mt-2 space-y-3">
        {blockedAgents.map((b, i) => (
          <div
            key={i}
            className="min-w-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-md bg-background/60 border border-red-500/20 text-foreground text-xs"
          >
            <div className="min-w-0 space-y-1">
              <div className="min-w-0 flex items-center gap-2 flex-wrap">
                <span className="min-w-0 break-anywhere font-medium text-red-600 dark:text-red-400 flex items-center gap-1 flex-wrap">
                  <AlertCircleIcon className="size-3.5" />
                  {b.agentName} ({b.client})
                </span>
                <span className="break-anywhere text-muted-foreground">• {b.developerName} ({b.connectionLabel})</span>
                <Badge variant="destructive" className="text-[10px] h-4 py-0">Blocked</Badge>
              </div>
              <p className="break-anywhere font-mono text-xs text-red-900 dark:text-red-300 font-medium">
                &ldquo;{b.blockerReason}&rdquo;
              </p>
            </div>
            {b.filesTouched.length > 0 && (
              <div className="min-w-0 flex items-center gap-1 flex-wrap text-[11px] text-muted-foreground">
                <span className="break-anywhere font-mono">{b.filesTouched.slice(0, 2).join(", ")}</span>
                {b.filesTouched.length > 2 && <span>+{b.filesTouched.length - 2} more</span>}
              </div>
            )}
          </div>
        ))}
      </AlertDescription>
    </Alert>
  );
}
