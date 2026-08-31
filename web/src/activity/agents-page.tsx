import { BotIcon } from "lucide-react";
import { useParams } from "react-router-dom";

import { agentListResponseSchema, type Agent } from "@/api/schemas";
import { Badge } from "@/components/ui/badge";

import { ActivityFrame } from "./activity-ui";
import { useProjectList } from "./use-project-list";
import { useVisiblePolling } from "./use-visible-polling";

export function AgentsPage() {
  const { projectId = "" } = useParams();
  const state = useProjectList<Agent>(projectId, "agents", agentListResponseSchema);
  useVisiblePolling(state.refresh, 5_000);
  return (
    <ActivityFrame {...state} title="Agents" description="Presence, capabilities, and the connection each agent uses." empty="Connect an MCP client and its agent will appear here." onLoadMore={state.loadMore}>
      {state.items.length === 0 ? null : (
        <div className="data-list" role="list" aria-label="Project agents">
          {state.items.map((agent) => (
            <article className="data-row data-row--agent" role="listitem" key={agent.id}>
              <span className={`row-icon row-icon--${agent.status}`}><BotIcon /></span>
              <div><strong>{agent.name}</strong><span>{agent.client} · {agent.connection?.label ?? "No connection"}</span></div>
              <div className="capability-list">{agent.capabilities.map((capability) => <Badge variant="outline" key={capability}>{capability}</Badge>)}</div>
              <div><strong className={`presence presence--${agent.status}`}>{agent.status}</strong><span>Last seen {new Date(agent.last_seen_at).toLocaleString()}</span></div>
            </article>
          ))}
        </div>
      )}
    </ActivityFrame>
  );
}
