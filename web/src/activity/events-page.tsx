import { ActivityIcon, CircleAlertIcon } from "lucide-react";
import { useParams } from "react-router-dom";

import { eventListResponseSchema, type ActivityEvent } from "@/api/schemas";

import { ActivityFrame } from "./activity-ui";
import { useProjectList } from "./use-project-list";
import { useVisiblePolling } from "./use-visible-polling";

function eventLabel(value: string): string {
  return value.split(".").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

export function EventsPage() {
  const { projectId = "" } = useParams();
  const state = useProjectList<ActivityEvent>(projectId, "events", eventListResponseSchema);
  useVisiblePolling(state.refresh, 5_000);
  return (
    <ActivityFrame {...state} title="Activity" description="A safe operational timeline for this project." empty="Agent, message, and connection events will appear here." onLoadMore={state.loadMore}>
      {state.items.length === 0 ? null : (
        <div className="data-list" role="list" aria-label="Project activity">
          {state.items.map((event) => (
            <article className="data-row data-row--event" role="listitem" key={event.id}>
              <span className={`row-icon row-icon--${event.outcome}`}>{event.outcome === "failure" ? <CircleAlertIcon /> : <ActivityIcon />}</span>
              <div><strong>{eventLabel(event.event_type)}</strong><span>{event.actor?.name ?? event.target?.name ?? "Project event"}</span></div>
              <div><strong>{event.outcome}</strong><span>{event.error_code ?? `Request ${event.request_id.slice(0, 8)}`}</span></div>
              <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time>
            </article>
          ))}
        </div>
      )}
    </ActivityFrame>
  );
}
