import { CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";

import { ApiError } from "@/api/client";
import { useSession } from "@/auth/session-store";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const redemptionResponseSchema = z.object({ project_id: z.uuidv4() }).strict();
type Failure = "unavailable" | "already-member" | "retry";

export function InvitationAcceptPage() {
  const { api } = useSession();
  const navigate = useNavigate();
  const started = useRef(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void api.mutate(
      "/api/v1/project-invitations/redeem",
      { method: "POST" },
      redemptionResponseSchema,
    ).then((response) => {
      if (response !== undefined) navigate(`/app/projects/${response.project_id}`, { replace: true });
    }).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "INVITATION_UNAVAILABLE") {
        setFailure("unavailable");
      } else if (error instanceof ApiError && error.code === "ALREADY_MEMBER") {
        setFailure("already-member");
      } else {
        setFailure("retry");
      }
    });
  }, [api, navigate, retryGeneration]);

  if (failure === null) {
    return (
      <main className="state-page" aria-label="Accepting invitation">
        <Brand />
        <h1>Joining shared project</h1>
        <p>Confirming your GitHub identity and read-only access…</p>
        <div className="state-page__skeletons" aria-hidden="true"><Skeleton className="h-10 w-56" /></div>
      </main>
    );
  }

  const heading = failure === "unavailable"
    ? "This invitation is unavailable"
    : failure === "already-member"
      ? "You already have access"
      : "Invitation could not be accepted";
  const description = failure === "unavailable"
    ? "The link may have expired, been revoked, or already been used. Ask the project owner for a new link."
    : failure === "already-member"
      ? "This GitHub account is already a member of the project. Open your projects to continue."
      : "AgentMesh could not complete the request. You can try once more or return to your projects.";

  return (
    <main className="state-page">
      <Brand />
      <CircleAlertIcon className="invitation-state-icon" aria-hidden="true" />
      <h1>{heading}</h1>
      <p>{description}</p>
      <div className="invitation-state-actions">
        {failure === "retry" ? (
          <Button type="button" variant="outline" onClick={() => {
            started.current = false;
            setFailure(null);
            setRetryGeneration((current) => current + 1);
          }}><RefreshCwIcon /> Try again</Button>
        ) : null}
        <Button asChild><Link to="/app">Open projects</Link></Button>
      </div>
    </main>
  );
}
