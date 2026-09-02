import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  FileCodeIcon,
  HistoryIcon,
  LaptopIcon,
  TargetIcon,
} from "lucide-react";
import { useState } from "react";

import type { PulseAgentSummary, PulseDeveloperSummary } from "@/api/schemas";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function StateBadge({ state }: { state: PulseAgentSummary["status"] | string }) {
  switch (state) {
    case "online":
      return (
        <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[11px] gap-1">
          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Online
        </Badge>
      );
    case "idle":
      return (
        <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[11px]">
          Idle
        </Badge>
      );
    case "offline":
      return (
        <Badge variant="outline" className="border-muted bg-muted/40 text-muted-foreground text-[11px]">
          Offline
        </Badge>
      );
    case "blocked":
      return (
        <Badge variant="destructive" className="text-[11px] gap-1">
          <AlertCircleIcon className="size-3" />
          Blocked
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[11px] gap-1">
          <CheckCircle2Icon className="size-3" />
          Done
        </Badge>
      );
    case "in_progress":
      return (
        <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[11px]">
          In Progress
        </Badge>
      );
    default:
      return <Badge variant="outline" className="text-[11px]">{state}</Badge>;
  }
}

function AgentRow({ agent }: { agent: PulseAgentSummary }) {
  const [showHistory, setShowHistory] = useState(false);
  const latest = agent.latest_progress;

  return (
    <div className="p-3.5 rounded-lg border bg-background/50 space-y-2.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <BotIcon className="size-4 text-blue-500" />
          <span className="font-semibold text-sm">{agent.name}</span>
          <span className="text-xs text-muted-foreground">({agent.client})</span>
        </div>
        <div className="flex items-center gap-2">
          <StateBadge state={agent.status} />
          {latest && <StateBadge state={latest.state} />}
        </div>
      </div>

      {agent.current_goal && (
        <div className="flex items-start gap-1.5 text-xs text-foreground/90 bg-muted/30 p-2 rounded-md border border-muted/50">
          <TargetIcon className="size-3.5 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <span className="text-muted-foreground font-medium">Goal: </span>
            <span className="font-medium">{agent.current_goal}</span>
          </div>
        </div>
      )}

      {latest ? (
        <div className="space-y-2 text-xs">
          <p className="text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground">Latest action: </span>
            {latest.summary}
          </p>

          {latest.state === "blocked" && latest.blocker_reason && (
            <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-red-700 dark:text-red-300 font-medium">
              ⚠️ Blocker: {latest.blocker_reason}
            </div>
          )}

          {latest.test_status && (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-muted-foreground">Test results:</span>
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                ✅ {latest.test_status.passed} passed
              </span>
              {latest.test_status.failed > 0 && (
                <span className="font-medium text-red-600 dark:text-red-400">
                  ❌ {latest.test_status.failed} failed
                </span>
              )}
            </div>
          )}

          {latest.files_touched.length > 0 && (
            <div className="space-y-1">
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <FileCodeIcon className="size-3" /> Touched files:
              </span>
              <div className="flex flex-wrap gap-1">
                {latest.files_touched.map((file, idx) => (
                  <span
                    key={idx}
                    className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border"
                  >
                    {file}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">No progress reports filed today yet.</p>
      )}

      {agent.history.length > 1 && (
        <div className="pt-1 border-t">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowHistory(!showHistory)}
            className="h-6 text-[11px] text-muted-foreground gap-1 px-1.5 hover:text-foreground"
          >
            <HistoryIcon className="size-3" />
            <span>{agent.history.length} updates today</span>
            {showHistory ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
          </Button>

          {showHistory && (
            <div className="mt-2 space-y-1.5 pl-3 border-l-2 border-muted">
              {agent.history.map((h) => (
                <div key={h.id} className="text-[11px] text-muted-foreground space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] text-foreground font-medium">{h.time}</span>
                    <span className="text-foreground/80">{h.summary}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DeveloperCard({ developer }: { developer: PulseDeveloperSummary }) {
  const initials = developer.display_name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const totalAgents = developer.connections.reduce((sum, c) => sum + c.agents.length, 0);

  return (
    <div className="p-4 sm:p-5 rounded-xl border bg-card text-card-foreground shadow-xs space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Avatar className="size-10 border">
            {developer.avatar_url ? (
              <AvatarImage src={developer.avatar_url} alt={developer.display_name} />
            ) : null}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div>
            <h3 className="font-semibold text-sm sm:text-base leading-tight">
              {developer.display_name}
            </h3>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
              <span>{developer.connections.length} device{developer.connections.length > 1 ? "s" : ""}</span>
              <span>•</span>
              <span>{totalAgents} agent{totalAgents > 1 ? "s" : ""}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {developer.connections.map((conn, idx) => (
          <div key={conn.connection_id ?? idx} className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
              <LaptopIcon className="size-3.5 text-violet-500" />
              <span>Device: {conn.label}</span>
            </div>

            <div className="grid gap-2.5">
              {conn.agents.map((agent) => (
                <AgentRow key={agent.agent_id} agent={agent} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
