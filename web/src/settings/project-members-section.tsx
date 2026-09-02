import { CheckIcon, CopyIcon, LinkIcon, Trash2Icon, UserMinusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  projectInvitationResponseSchema,
  projectMembersResponseSchema,
  type ProjectInvitation,
  type ProjectMember,
} from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

function initials(member: ProjectMember): string {
  return member.display_name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
}

function expiryLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function ProjectMembersSection({ projectId }: { projectId: string }) {
  const { api } = useSession();
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await api.query(`/api/v1/projects/${projectId}/members`, projectMembersResponseSchema);
    setMembers(response.members);
    setInvitations(response.invitations);
  }, [api, projectId]);

  useEffect(() => {
    let active = true;
    void load().catch(() => {
      if (active) setError("Members are temporarily unavailable.");
    });
    return () => {
      active = false;
    };
  }, [load]);

  const createInvitation = async () => {
    setBusy(true);
    try {
      const response = await api.mutate(
        `/api/v1/projects/${projectId}/invitations`,
        { method: "POST", body: {} },
        projectInvitationResponseSchema,
      );
      if (response !== undefined) {
        setInvitationUrl(response.invitation.url);
        setInvitations((current) => [...current.filter((item) => item.id !== response.invitation.id), response.invitation]);
      }
      setCopied(false);
      setError(null);
    } catch {
      setError("The viewer link could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const copyInvitation = async () => {
    if (invitationUrl === null) return;
    try {
      await navigator.clipboard.writeText(invitationUrl);
      setCopied(true);
      setError(null);
    } catch {
      setError("Copy is unavailable. Select the link and copy it manually.");
    }
  };

  const revokeInvitation = async (invitationId: string) => {
    setBusy(true);
    try {
      await api.mutate(`/api/v1/projects/${projectId}/invitations/${invitationId}`, { method: "DELETE" });
      setInvitationUrl(null);
      await load();
      setError(null);
    } catch {
      setError("The invitation could not be revoked.");
    } finally {
      setBusy(false);
    }
  };

  const removeViewer = async () => {
    if (removeTarget === null) return;
    setBusy(true);
    try {
      await api.mutate(`/api/v1/projects/${projectId}/members/${removeTarget.user_id}`, { method: "DELETE" });
      setRemoveTarget(null);
      await load();
      setError(null);
    } catch {
      setError("The viewer could not be removed.");
    } finally {
      setBusy(false);
    }
  };

  const viewers = members?.filter((member) => member.role === "viewer") ?? [];

  return (
    <section className="members-section" aria-labelledby="members-heading">
      <div className="members-section__heading">
        <div>
          <h2 id="members-heading">Members</h2>
          <p>Invite a GitHub user to view this project. Only you can make changes.</p>
        </div>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void createInvitation()}>
          <LinkIcon /> Create viewer link
        </Button>
      </div>

      {error === null ? null : <Alert variant="destructive"><AlertTitle>Action failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}

      {invitationUrl === null ? null : (
        <div className="invitation-link">
          <Label htmlFor="viewer-invitation-link">Viewer invitation link</Label>
          <div className="invitation-link__controls">
            <Input id="viewer-invitation-link" value={invitationUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={() => void copyInvitation()}>
              {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
          <p>This single-use link expires in 7 days. The recipient signs in with GitHub before access is granted.</p>
        </div>
      )}

      {members === null ? <div className="member-list"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div> : (
        <div className="member-list">
          {members.map((member) => (
            <div className="member-row" key={member.user_id}>
              <Avatar>
                {member.avatar_url === null ? null : <AvatarImage src={member.avatar_url} alt="" />}
                <AvatarFallback>{initials(member)}</AvatarFallback>
              </Avatar>
              <div className="member-row__identity">
                <strong>{member.display_name}</strong>
                <span>@{member.github_login}</span>
              </div>
              <Badge variant={member.role === "owner" ? "default" : "secondary"}>{member.role}</Badge>
              {member.role === "viewer" ? (
                <Dialog open={removeTarget?.user_id === member.user_id} onOpenChange={(open) => setRemoveTarget(open ? member : null)}>
                  <DialogTrigger asChild><Button type="button" variant="ghost" aria-label={`Remove ${member.display_name}`}><UserMinusIcon /></Button></DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Remove {member.display_name}?</DialogTitle>
                      <DialogDescription>They will immediately lose access to this project. You can invite them again later.</DialogDescription>
                    </DialogHeader>
                    <DialogFooter><Button type="button" variant="destructive" disabled={busy} onClick={() => void removeViewer()}>Confirm removal</Button></DialogFooter>
                  </DialogContent>
                </Dialog>
              ) : null}
            </div>
          ))}
          {viewers.length === 0 ? <p className="member-list__empty">Only you currently have access.</p> : null}
        </div>
      )}

      <div className="pending-invitations">
        <h3>Pending invitations</h3>
        {invitations.length === 0 ? <p>No pending invitation links.</p> : invitations.map((invitation) => (
          <div className="member-row" key={invitation.id}>
            <div className="pending-invitation__icon"><LinkIcon /></div>
            <div className="member-row__identity">
              <strong>Pending viewer link</strong>
              <span>Expires {expiryLabel(invitation.expires_at)}</span>
            </div>
            <Badge variant="outline">viewer</Badge>
            <Button type="button" variant="ghost" disabled={busy} aria-label="Revoke viewer link" onClick={() => void revokeInvitation(invitation.id)}><Trash2Icon /></Button>
          </div>
        ))}
      </div>
    </section>
  );
}
