import { ArrowLeftIcon, BanIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  operatorUserDetailResponseSchema,
  operatorUserMutationResponseSchema,
  type OperatorUserMetadata,
} from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { ConfirmationDialog } from "./confirmation-dialog";
import { MetadataItem, OperatorActionError, OperatorLoadError, OperatorLoading, formatTimestamp } from "./operator-ui";

export function OperatorUserPage() {
  const { userId = "" } = useParams();
  const { api, state } = useSession();
  const [user, setUser] = useState<OperatorUserMetadata | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadGeneration = useRef(0);
  const mutationGeneration = useRef(0);
  const routeId = useRef(userId);
  routeId.current = userId;

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoadFailed(false);
    setUser(null);
    try {
      const response = await api.query(`/api/v1/ops/users/${userId}`, operatorUserDetailResponseSchema);
      if (generation !== loadGeneration.current || routeId.current !== userId || response.user.id !== userId) return;
      setUser(response.user);
    } catch {
      if (generation !== loadGeneration.current || routeId.current !== userId) return;
      setLoadFailed(true);
    }
  }, [api, userId]);

  useEffect(() => {
    mutationGeneration.current += 1;
    setActionFailed(false);
    setConfirmationOpen(false);
    setBusy(false);
    void load();
    return () => {
      loadGeneration.current += 1;
      mutationGeneration.current += 1;
    };
  }, [load]);

  if (user === null && !loadFailed) return <OperatorLoading label="Loading user metadata" />;
  if (user === null) return <OperatorLoadError heading="User metadata is temporarily unavailable" onRetry={() => void load()} />;

  const blocked = user.blocked_at !== null;
  const mutateState = async () => {
    const targetUserId = user.id;
    const generation = ++mutationGeneration.current;
    setBusy(true);
    setActionFailed(false);
    try {
      const operation = blocked ? "unblock" : "block";
      const response = await api.mutate(
        `/api/v1/ops/users/${targetUserId}/${operation}`,
        { method: "POST" },
        operatorUserMutationResponseSchema,
      );
      if (response === undefined) throw new Error("Missing user response");
      if (response.user.id !== targetUserId) throw new Error("Mismatched user response");
      if (generation !== mutationGeneration.current || routeId.current !== targetUserId) return;
      setUser((current) => current?.id === targetUserId ? { ...current, ...response.user } : current);
    } catch {
      if (generation === mutationGeneration.current && routeId.current === targetUserId) setActionFailed(true);
    } finally {
      if (generation === mutationGeneration.current && routeId.current === targetUserId) setBusy(false);
    }
  };

  const currentOperatorId = state.status === "authenticated" ? state.session.user.id : null;
  const isCurrentOperator = currentOperatorId === user.id;

  return (
    <section className="ops-page">
      <Link className="ops-back-link" to="/ops/users"><ArrowLeftIcon aria-hidden="true" /> Back to users</Link>
      <header className="ops-detail-heading">
        <div>
          <p className="ops-eyebrow">User metadata</p>
          <h1>{user.display_name}</h1>
          <p>@{user.github_login}</p>
        </div>
        <Badge variant={blocked ? "destructive" : "outline"}>{blocked ? "Blocked" : "Active"}</Badge>
      </header>
      {actionFailed ? <OperatorActionError>The user state could not be changed. Reload metadata and try again.</OperatorActionError> : null}
      <dl className="ops-metadata">
        <MetadataItem label="User ID"><code>{user.id}</code></MetadataItem>
        <MetadataItem label="GitHub ID">{user.github_user_id}</MetadataItem>
        <MetadataItem label="Projects">{user.active_project_count} active of {user.project_count} total</MetadataItem>
        <MetadataItem label="Created">{formatTimestamp(user.created_at)}</MetadataItem>
        <MetadataItem label="Updated">{formatTimestamp(user.updated_at)}</MetadataItem>
        <MetadataItem label="Blocked at">{formatTimestamp(user.blocked_at)}</MetadataItem>
      </dl>
      <section className="ops-action-panel" aria-labelledby="user-lifecycle-heading">
        <div>
          <h2 id="user-lifecycle-heading">Account lifecycle</h2>
          <p>{isCurrentOperator
            ? "The current operator account cannot be blocked from this console."
            : blocked
            ? "Unblocking permits new authenticated sessions. Previously revoked sessions remain revoked."
            : "Blocking revokes active web sessions and prevents project authentication for this owner."}</p>
        </div>
        {isCurrentOperator ? null : <ConfirmationDialog
          open={confirmationOpen}
          onOpenChange={setConfirmationOpen}
          busy={busy}
          title={`${blocked ? "Unblock" : "Block"} ${user.display_name}?`}
          description={blocked
            ? "This user can authenticate again, but revoked sessions are not restored."
            : "Active web sessions will be revoked immediately. Project data is retained."}
          actionLabel={blocked ? "Confirm unblock" : "Confirm block"}
          onConfirm={() => void mutateState()}
        >
          <Button type="button" variant={blocked ? "outline" : "destructive"} disabled={busy}>
            {blocked ? <ShieldCheckIcon /> : <BanIcon />}
            {blocked ? "Unblock user" : "Block user"}
          </Button>
        </ConfirmationDialog>}
      </section>
    </section>
  );
}
