import { CheckIcon, CopyIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import type { DailyPulseResponse } from "@/api/schemas";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export function generateStandupMarkdown(pulse: DailyPulseResponse): string {
  let md = `### 🚀 AI Team Activity Digest (${pulse.date})\n\n`;

  if (pulse.developers.length === 0) {
    return md + "_No agent activity recorded for this day._\n";
  }

  for (const dev of pulse.developers) {
    md += `**👤 ${dev.display_name}:**\n`;
    for (const conn of dev.connections) {
      for (const agent of conn.agents) {
        const goal = agent.current_goal ? ` — *Goal: ${agent.current_goal}*` : "";
        const summary = agent.latest_progress?.summary || "Active session";
        const tests = agent.latest_progress?.test_status
          ? ` (${agent.latest_progress.test_status.passed} tests passed${
              agent.latest_progress.test_status.failed > 0
                ? `, ${agent.latest_progress.test_status.failed} failed`
                : ""
            })`
          : "";
        const files = agent.latest_progress?.files_touched.length
          ? ` [${agent.latest_progress.files_touched.slice(0, 3).join(", ")}${
              agent.latest_progress.files_touched.length > 3 ? "..." : ""
            }]`
          : "";

        md += `- [${agent.name} / ${agent.client}] ${summary}${goal}${tests}${files}\n`;

        if (agent.latest_progress?.state === "blocked" && agent.latest_progress.resolved_at === null) {
          md += `  ⚠️ **BLOCKER:** ${agent.latest_progress.blocker_reason ?? "Requires attention"}\n`;
        }
      }
    }
    md += "\n";
  }

  if (pulse.summary.unique_files_touched.length > 0) {
    md += `📁 **Total files modified today (${pulse.summary.unique_files_touched.length}):**\n`;
    md += pulse.summary.unique_files_touched.map((f) => `- \`${f}\``).join("\n");
    md += "\n";
  }

  return md;
}

export function StandupExportDialog({ pulse }: { pulse: DailyPulseResponse }) {
  const [copied, setCopied] = useState(false);
  const markdownText = generateStandupMarkdown(pulse);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(markdownText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <SparklesIcon className="size-4 text-amber-500" />
          <span>Daily Standup Report</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-5 text-amber-500" />
            <span>Generate Standup Digest</span>
          </DialogTitle>
          <DialogDescription>
            Copy ready-to-use markdown summary of today&apos;s team agent activity for Slack, Telegram, or Jira.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <Textarea
            readOnly
            value={markdownText}
            className="font-mono text-xs h-64 resize-none bg-muted/40"
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button onClick={handleCopy} className="gap-2 w-full sm:w-auto">
            {copied ? (
              <>
                <CheckIcon className="size-4 text-emerald-500" />
                <span>Copied to Clipboard!</span>
              </>
            ) : (
              <>
                <CopyIcon className="size-4" />
                <span>Copy Markdown</span>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
