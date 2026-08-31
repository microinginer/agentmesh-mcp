import { ArrowRightIcon, CheckCircle2Icon, Clock3Icon, MessageCircleIcon } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router-dom";

import {
  messageDetailResponseSchema,
  messageListResponseSchema,
  type MessageDetail,
  type MessageListItem,
} from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { ActivityFrame } from "./activity-ui";
import { useProjectList } from "./use-project-list";
import { useVisiblePolling } from "./use-visible-polling";

export function MessagesPage() {
  const { projectId = "" } = useParams();
  const { api } = useSession();
  const state = useProjectList<MessageListItem>(projectId, "messages", messageListResponseSchema);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailError, setDetailError] = useState(false);
  useVisiblePolling(state.refresh, 5_000);

  const openDetail = async (message: MessageListItem) => {
    setDetailOpen(true);
    setDetail(null);
    setDetailError(false);
    try {
      const response = await api.query(
        `/api/v1/projects/${projectId}/messages/${message.id}`,
        messageDetailResponseSchema,
      );
      setDetail(response.message);
    } catch {
      setDetailError(true);
    }
  };

  return (
    <>
      <ActivityFrame {...state} title="Messages" description="Direct agent communication and acknowledgement state." empty="Messages exchanged by connected agents will appear here." onLoadMore={state.loadMore}>
        {state.items.length === 0 ? null : (
          <div className="data-list" role="list" aria-label="Project messages">
            {state.items.map((message) => (
              <article className="data-row data-row--message" role="listitem" key={message.id}>
                <span className="row-icon"><MessageCircleIcon /></span>
                <div className="message-route"><strong>{message.sender.name}</strong><ArrowRightIcon /><strong>{message.recipient.name}</strong></div>
                <p>{message.preview}</p>
                <span className="message-state">{message.acknowledged_at === null ? <><Clock3Icon /> Awaiting ACK</> : <><CheckCircle2Icon /> Acknowledged</>}</span>
                <Button type="button" variant="ghost" onClick={() => void openDetail(message)} aria-label={`View message from ${message.sender.name}`}>View</Button>
              </article>
            ))}
          </div>
        )}
      </ActivityFrame>
      <Dialog open={detailOpen} onOpenChange={(open) => {
        setDetailOpen(open);
        if (!open) setDetail(null);
      }}>
        <DialogContent className="message-dialog">
          <DialogHeader>
            <DialogTitle>Message detail</DialogTitle>
            <DialogDescription>{detail === null ? "Loading message…" : `${detail.sender.name} to ${detail.recipient.name}`}</DialogDescription>
          </DialogHeader>
          {detailError ? <p>Message detail is temporarily unavailable.</p> : detail === null ? null : <pre className="message-body">{detail.text}</pre>}
        </DialogContent>
      </Dialog>
    </>
  );
}
