import { ArchiveIcon, ArrowLeftIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  operatorProjectArchiveResponseSchema,
  operatorProjectDetailResponseSchema,
  type OperatorProjectMetadata,
} from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { ConfirmationDialog } from "./confirmation-dialog";
import { MetadataItem, OperatorActionError, OperatorLoadError, OperatorLoading, formatTimestamp } from "./operator-ui";

export function OperatorProjectPage() {
  const { projectId = "" } = useParams();
  const { api } = useSession();
  const [project, setProject] = useState<OperatorProjectMetadata | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadGeneration = useRef(0);
  const mutationGeneration = useRef(0);
  const routeId = useRef(projectId);
  routeId.current = projectId;

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoadFailed(false);
    setProject(null);
    try {
      const response = await api.query(`/api/v1/ops/projects/${projectId}`, operatorProjectDetailResponseSchema);
      if (generation !== loadGeneration.current || routeId.current !== projectId || response.project.id !== projectId) return;
      setProject(response.project);
    } catch {
      if (generation !== loadGeneration.current || routeId.current !== projectId) return;
      setLoadFailed(true);
    }
  }, [api, projectId]);

  useEffect(() => {
    mutationGeneration.current += 1;
    setActionFailed(false);
    setArchiveOpen(false);
    setBusy(false);
    void load();
    return () => {
      loadGeneration.current += 1;
      mutationGeneration.current += 1;
    };
  }, [load]);

  if (project === null && !loadFailed) return <OperatorLoading label="Loading project metadata" />;
  if (project === null) return <OperatorLoadError heading="Project metadata is temporarily unavailable" onRetry={() => void load()} />;

  const archive = async () => {
    const targetProjectId = project.id;
    const generation = ++mutationGeneration.current;
    setBusy(true);
    setActionFailed(false);
    try {
      const response = await api.mutate(
        `/api/v1/ops/projects/${targetProjectId}/archive`,
        { method: "POST" },
        operatorProjectArchiveResponseSchema,
      );
      if (response === undefined) throw new Error("Missing project response");
      if (response.project.id !== targetProjectId) throw new Error("Mismatched project response");
      if (generation !== mutationGeneration.current || routeId.current !== targetProjectId) return;
      setProject((current) => current?.id === targetProjectId ? { ...current, ...response.project } : current);
    } catch {
      if (generation === mutationGeneration.current && routeId.current === targetProjectId) setActionFailed(true);
    } finally {
      if (generation === mutationGeneration.current && routeId.current === targetProjectId) setBusy(false);
    }
  };

  return (
    <section className="ops-page">
      <Link className="ops-back-link" to="/ops/projects"><ArrowLeftIcon aria-hidden="true" /> Back to projects</Link>
      <header className="ops-detail-heading">
        <div>
          <p className="ops-eyebrow">Project metadata</p>
          <h1>{project.name}</h1>
          <p>{project.owner?.display_name ?? "Ownerless project"}</p>
        </div>
        <Badge variant={project.status === "active" ? "outline" : "secondary"}>
          {project.status === "active" ? "Active" : "Archived"}
        </Badge>
      </header>
      {actionFailed ? <OperatorActionError>The project could not be archived. Reload metadata and try again.</OperatorActionError> : null}
      <dl className="ops-metadata">
        <MetadataItem label="Project ID"><code>{project.id}</code></MetadataItem>
        <MetadataItem label="Owner">{project.owner === null ? "None" : `@${project.owner.github_login ?? "unknown"}`}</MetadataItem>
        <MetadataItem label="Agents">{project.counts.agents} agents</MetadataItem>
        <MetadataItem label="Messages">{project.counts.messages} messages</MetadataItem>
        <MetadataItem label="Connections">{project.counts.connections} connections</MetadataItem>
        <MetadataItem label="Created">{formatTimestamp(project.created_at)}</MetadataItem>
        <MetadataItem label="Updated">{formatTimestamp(project.updated_at)}</MetadataItem>
        <MetadataItem label="Archived at">{formatTimestamp(project.archived_at)}</MetadataItem>
      </dl>
      <section className="ops-action-panel" aria-labelledby="project-lifecycle-heading">
        <div>
          <h2 id="project-lifecycle-heading">Project lifecycle</h2>
          <p>{project.status === "active"
            ? "Archiving stops project authentication while retaining metadata and project records."
            : "This project is archived. The operator API does not expose restore or destructive content controls."}</p>
        </div>
        {project.status === "active" ? (
          <ConfirmationDialog
            open={archiveOpen}
            onOpenChange={setArchiveOpen}
            busy={busy}
            title={`Archive ${project.name}?`}
            description="Project authentication stops immediately. Messages and credentials remain hidden from this console."
            actionLabel="Confirm archive"
            onConfirm={() => void archive()}
          >
            <Button type="button" variant="destructive" disabled={busy}><ArchiveIcon /> Archive project</Button>
          </ConfirmationDialog>
        ) : null}
      </section>
    </section>
  );
}
