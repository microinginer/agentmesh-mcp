import {
  ActivityIcon,
  ArrowRightIcon,
  BotIcon,
  CircleAlertIcon,
  FolderKanbanIcon,
  LinkIcon,
  MessageCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  agentListResponseSchema,
  connectionListResponseSchema,
  eventListResponseSchema,
  overviewResponseSchema,
  type Agent,
  type Connection,
  type EventListResponse,
  type OverviewResponse,
} from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

import { ProjectShell } from "./project-shell";

interface OverviewData {
  overview: OverviewResponse["overview"];
  agents: Agent[];
  events: EventListResponse["items"];
  connections: Connection[];
}

function eventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    "agent.registered": "Agent registered",
    "connection.created": "Connection created",
    "connection.revoked": "Connection revoked",
    "message.sent": "Message sent",
    "message.acknowledged": "Message acknowledged",
  };
  return labels[eventType] ?? eventType.split(".").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function relativeTime(timestamp: string): string {
  const elapsed = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function ProjectOverviewPage() {
  const projectId = useParams().projectId ?? "";
  const { api } = useSession();
  const [data, setData] = useState<OverviewData | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [overview, agents, events, connections] = await Promise.all([
        api.query(`/api/v1/projects/${projectId}/overview`, overviewResponseSchema),
        api.query(`/api/v1/projects/${projectId}/agents?limit=50`, agentListResponseSchema),
        api.query(`/api/v1/projects/${projectId}/events?limit=20`, eventListResponseSchema),
        api.query(`/api/v1/projects/${projectId}/connections?limit=50`, connectionListResponseSchema),
      ]);
      setData({
        overview: overview.overview,
        agents: agents.items,
        events: events.items,
        connections: connections.connections,
      });
    } catch {
      setFailed(true);
    }
  }, [api, projectId]);

  useEffect(() => { void load(); }, [load]);

  if (data === null && !failed) {
    return (
      <ProjectShell projectId={projectId}>
        <section className="overview-loading" aria-label="Loading project overview">
          <Skeleton className="h-10 w-72" />
          <div className="summary-grid">
            {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-24 w-full" />)}
          </div>
          <Skeleton className="h-64 w-full" />
        </section>
      </ProjectShell>
    );
  }

  if (failed || data === null) {
    return (
      <ProjectShell projectId={projectId}>
        <Empty className="workspace-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CircleAlertIcon /></EmptyMedia>
            <EmptyTitle>Project overview is temporarily unavailable</EmptyTitle>
            <EmptyDescription>No project data was changed.</EmptyDescription>
          </EmptyHeader>
          <Button type="button" variant="outline" onClick={() => void load()}>Try again</Button>
        </Empty>
      </ProjectShell>
    );
  }

  const overview = data.overview;
  return (
    <ProjectShell projectId={projectId} projectName={overview.project.name}>
      <section className="overview-page">
        <header className="page-heading page-heading--action">
          <div>
            <h1>AgentMesh</h1>
            <p>Coordinate agents without stepping on each other.</p>
          </div>
          <Button asChild size="lg">
            <Link to={`/app/projects/${projectId}/connections`} state={{ createConnection: true }}>
              <span aria-hidden="true">＋</span> New connection
            </Link>
          </Button>
        </header>
        <Separator />

        <div className="summary-grid" aria-label="Project summary">
          <article className="summary-item">
            <FolderKanbanIcon />
            <div><strong>1</strong><span>active workspace</span></div>
          </article>
          <article className="summary-item summary-item--presence">
            <BotIcon />
            <div>
              <strong><span className="metric-online">{overview.agents.online} online</span></strong>
              <span>{overview.agents.idle} idle · {overview.agents.offline} offline</span>
            </div>
          </article>
          <article className="summary-item" id="messages">
            <MessageCircleIcon />
            <div><strong>{overview.messages.total} messages</strong><span>{overview.messages.unacknowledged} unacknowledged</span></div>
          </article>
          <article className="summary-item summary-item--danger">
            <CircleAlertIcon />
            <div><strong>{overview.failures_last_24h} {overview.failures_last_24h === 1 ? "failure" : "failures"}</strong><span>in 24 hours</span></div>
          </article>
        </div>

        <div className="overview-columns">
          <section className="overview-section" id="agents">
            <header><h2>Agent presence</h2><a href="#agents">View all agents</a></header>
            {data.agents.length === 0 ? (
              <Empty className="inline-empty"><EmptyHeader><EmptyTitle>No agents connected</EmptyTitle><EmptyDescription>Create a connection to bring an agent online.</EmptyDescription></EmptyHeader></Empty>
            ) : (
              <div className="open-list" role="list" aria-label="Agent presence">
                {data.agents.map((agent) => (
                  <article key={agent.id} className="agent-row" role="listitem">
                    <span className={`status-orb status-orb--${agent.status}`} />
                    <div><strong>{agent.name}</strong><span>{agent.client}</span></div>
                    <div><strong className={`presence presence--${agent.status}`}>{agent.status}</strong><span>Last seen {relativeTime(agent.last_seen_at)}</span></div>
                    <span>{agent.connection?.label ?? "No connection"}</span>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="overview-section overview-section--activity" id="activity">
            <header><h2>Recent activity</h2><a href="#activity">View all activity</a></header>
            {data.events.length === 0 ? (
              <Empty className="inline-empty"><EmptyHeader><EmptyTitle>No recent activity</EmptyTitle><EmptyDescription>Agent and connection events will appear here.</EmptyDescription></EmptyHeader></Empty>
            ) : (
              <div className="activity-list" role="list" aria-label="Recent activity">
                {data.events.map((event) => (
                  <article key={event.id} className="activity-row" role="listitem">
                    <span className={`activity-icon activity-icon--${event.outcome}`}><ActivityIcon /></span>
                    <div><strong>{eventLabel(event.event_type)}</strong><span>{event.actor?.name ?? event.target?.name ?? "Project event"}</span></div>
                    <time dateTime={event.created_at}>{relativeTime(event.created_at)}</time>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="overview-section connection-health">
          <header>
            <h2>Connection health</h2>
            <Link to={`/app/projects/${projectId}/connections`}>Manage connections <ArrowRightIcon /></Link>
          </header>
          {data.connections.length === 0 ? (
            <Empty className="inline-empty"><EmptyHeader><EmptyTitle>No connections yet</EmptyTitle><EmptyDescription>Create one token for each computer or agent.</EmptyDescription></EmptyHeader></Empty>
          ) : (
            <div className="open-list" role="list" aria-label="Connection health">
              {data.connections.map((connection) => (
                <article key={connection.id} className="connection-health-row" role="listitem">
                  <LinkIcon />
                  <div><strong>{connection.label}</strong><span>MCP project connection</span></div>
                  <span className={`presence presence--${connection.status === "active" ? "online" : "offline"}`}>{connection.status}</span>
                  <span>{connection.last_used_at === null ? "Never used" : relativeTime(connection.last_used_at)}</span>
                  <span>{connection.expires_at === null ? "No expiry" : new Date(connection.expires_at).toLocaleDateString()}</span>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </ProjectShell>
  );
}
