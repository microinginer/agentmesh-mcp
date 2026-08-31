import { CheckCircle2Icon, ClipboardIcon, LaptopIcon, LinkIcon, PlusIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";

import {
  connectionListResponseSchema,
  connectionResponseSchema,
  issueConnectionResponseSchema,
  projectResponseSchema,
  type Connection,
  type IssueConnectionResponse,
  type Project,
} from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ProjectShell } from "@/projects/project-shell";

interface ConnectionCreatorProps {
  api: ReturnType<typeof useSession>["api"];
  projectId: string;
  onIssued: (connection: Connection) => void;
  onRevoke: (connection: Connection) => Promise<void>;
}

function ConnectionCreator({ api, projectId, onIssued, onRevoke }: ConnectionCreatorProps) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<IssueConnectionResponse | null>(null);
  const secretRef = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const submitting = useRef(false);

  useEffect(() => () => { secretRef.current = null; }, []);

  const reset = () => {
    secretRef.current = null;
    setResult(null);
    setError(null);
    setCopyError(false);
    setPending(false);
    submitting.current = false;
  };

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    const label = String(new FormData(event.currentTarget).get("label") ?? "").trim();
    if (label.length === 0) {
      setError("Connection label is required.");
      return;
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const issued = await api.mutate(`/api/v1/projects/${projectId}/connections`, {
        method: "POST",
        body: { label },
        idempotencyKey: crypto.randomUUID(),
      }, issueConnectionResponseSchema);
      if (issued === undefined) throw new Error("Missing issue response");
      secretRef.current = issued.secret;
      setResult(issued);
      onIssued(issued.connection);
    } catch {
      setError("The connection could not be created. Try again.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  const copy = async () => {
    const value = secretRef.current;
    if (value === null || navigator.clipboard?.writeText === undefined) {
      setCopyError(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };

  const revokeAndReset = async () => {
    if (result === null) return;
    await onRevoke(result.connection);
    reset();
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="lg" onClick={() => setOpen(true)}>
          <PlusIcon data-icon="inline-start" /> New connection
        </Button>
      </DialogTrigger>
      <DialogContent className="connection-dialog">
        {result === null ? (
          <>
            <DialogHeader>
              <DialogTitle>New connection</DialogTitle>
              <DialogDescription>Create a separate project token for this computer or agent.</DialogDescription>
            </DialogHeader>
            <form className="connection-create-form" onSubmit={(event) => void submit(event)}>
              <FieldGroup>
                <Field data-invalid={error !== null}>
                  <FieldLabel htmlFor="connection-label">Connection label</FieldLabel>
                  <Input id="connection-label" name="label" maxLength={80} placeholder="e.g. Main Mac" aria-invalid={error !== null} autoFocus />
                  {error === null ? null : <FieldError>{error}</FieldError>}
                </Field>
              </FieldGroup>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => changeOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={pending}>{pending ? "Creating connection…" : "Create connection"}</Button>
              </DialogFooter>
            </form>
          </>
        ) : (
          <>
            <DialogHeader className="connection-dialog__success">
              <CheckCircle2Icon />
              <div>
                <DialogTitle>Connection created</DialogTitle>
                <DialogDescription>{result.connection.label}</DialogDescription>
              </div>
            </DialogHeader>
            {result.secret_recoverable && result.secret !== null ? (
              <>
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle>Copy this token now. It cannot be shown again.</AlertTitle>
                </Alert>
                <div className="secret-box">
                  <code>{result.secret}</code>
                  <Button type="button" variant="outline" onClick={() => void copy()}>
                    <ClipboardIcon data-icon="inline-start" /> Copy token
                  </Button>
                </div>
                {copyError ? <p className="copy-error" role="status">Copy is unavailable. Select and copy the token manually.</p> : null}
                <ol className="next-steps">
                  <li><span>1</span><div><strong>Set an environment variable</strong><p>Store the token as <code>AGENTMESH_TOKEN</code>.</p></div></li>
                  <li><span>2</span><div><strong>Configure the MCP server URL</strong><p>Use the AgentMesh MCP endpoint from your deployment.</p></div></li>
                  <li><span>3</span><div><strong>Restart the agent</strong><p>Restart the MCP client to apply the new connection.</p></div></li>
                </ol>
              </>
            ) : (
              <Alert variant="destructive">
                <RotateCcwIcon />
                <AlertTitle>Token response was already used</AlertTitle>
                <AlertDescription>This token cannot be recovered. Revoke and recreate the connection.</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="destructive" onClick={() => void revokeAndReset()}>Revoke and recreate</Button>
              <Button type="button" onClick={() => changeOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function displayStatus(status: Connection["status"]) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function ConnectionsPage() {
  const projectId = useParams().projectId ?? "";
  const { api } = useSession();
  const [project, setProject] = useState<Project | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [failed, setFailed] = useState(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setProject(null);
    setConnections(null);
    setFailed(false);
    try {
      const [projectResult, connectionResult] = await Promise.all([
        api.query(`/api/v1/projects/${projectId}`, projectResponseSchema),
        api.query(`/api/v1/projects/${projectId}/connections?limit=50`, connectionListResponseSchema),
      ]);
      if (generation !== loadGeneration.current) return;
      setProject(projectResult.project);
      setConnections(connectionResult.connections);
    } catch {
      if (generation !== loadGeneration.current) return;
      setFailed(true);
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  const issued = (connection: Connection) => {
    setConnections((current) => {
      if (current === null) return [connection];
      return [connection, ...current.filter((item) => item.id !== connection.id)];
    });
  };

  const revoke = async (connection: Connection) => {
    const response = await api.mutate(`/api/v1/projects/${projectId}/connections/${connection.id}/revoke`, {
      method: "POST",
    }, connectionResponseSchema);
    if (response === undefined) return;
    setConnections((current) => current?.map((item) => item.id === response.connection.id ? response.connection : item) ?? []);
  };

  if ((project === null || connections === null) && !failed) {
    return (
      <ProjectShell projectId={projectId}>
        <section className="connections-loading" aria-label="Loading connections">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-64 w-full" />
        </section>
      </ProjectShell>
    );
  }

  if (failed || project === null || connections === null) {
    return (
      <ProjectShell projectId={projectId}>
        <Empty className="workspace-empty"><EmptyHeader><EmptyTitle>Connections are temporarily unavailable</EmptyTitle><EmptyDescription>No tokens were changed.</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => void load()}>Try again</Button></Empty>
      </ProjectShell>
    );
  }

  return (
    <ProjectShell projectId={projectId} projectName={project.name}>
      <section className="connections-page">
        <header className="page-heading page-heading--action">
          <div><h1>Connections</h1><p>Create a separate project token for each computer or agent.</p></div>
          <ConnectionCreator
            api={api}
            projectId={projectId}
            onIssued={issued}
            onRevoke={revoke}
          />
        </header>
        {connections.length === 0 ? (
          <Empty className="workspace-empty workspace-empty--bordered">
            <EmptyHeader><EmptyTitle>No connections yet</EmptyTitle><EmptyDescription>Create a separate token for your first computer or agent.</EmptyDescription></EmptyHeader>
          </Empty>
        ) : (
          <div className="connections-list" role="list" aria-label="Connections">
            <div className="connections-list__header" aria-hidden="true">
              <span>{connections.length} connections</span><span>Status</span><span>Created</span><span>Expires</span><span>Last used</span><span>Actions</span>
            </div>
            {connections.map((connection) => (
              <article key={connection.id} className="connection-row" role="listitem" aria-label={`${connection.label} connection`}>
                <div className="connection-row__name"><span className="row-icon"><LaptopIcon /></span><strong>{connection.label}</strong></div>
                <Badge className={cn("connection-status", `connection-status--${connection.status}`)} variant="outline">
                  <span className={`status-orb status-orb--${connection.status === "active" ? "online" : "offline"}`} />
                  {displayStatus(connection.status)}
                </Badge>
                <time dateTime={connection.created_at}>{new Date(connection.created_at).toLocaleDateString()}</time>
                <span>{connection.expires_at === null ? "No expiry" : new Date(connection.expires_at).toLocaleDateString()}</span>
                <span>{connection.last_used_at === null ? "Never used" : new Date(connection.last_used_at).toLocaleString()}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={connection.status === "revoked"}
                  aria-label={`Revoke ${connection.label}`}
                  onClick={() => void revoke(connection)}
                >
                  {connection.status === "revoked" ? "Revoked" : "Revoke"}
                </Button>
              </article>
            ))}
          </div>
        )}
      </section>
    </ProjectShell>
  );
}
