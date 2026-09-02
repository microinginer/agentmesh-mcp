import { ArchiveIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { ApiError } from "@/api/client";
import { projectResponseSchema, type Project } from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { ProjectShell } from "@/projects/project-shell";

export function ProjectSettings() {
  const { projectId = "" } = useParams();
  const { api } = useSession();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void api.query(`/api/v1/projects/${projectId}`, projectResponseSchema).then((response) => {
      if (active) setProject(response.project);
    }).catch(() => {
      if (active) setError("Project settings are temporarily unavailable.");
    });
    return () => {
      active = false;
    };
  }, [api, projectId]);

  if (project === null && error === null) return <section className="settings-page settings-page--loading"><Skeleton className="h-10 w-60" /><Skeleton className="h-64 w-full" /></section>;
  if (project === null) return <section className="state-page"><h1>Settings unavailable</h1><p>{error}</p></section>;

  if (!project.can_edit) {
    return (
      <ProjectShell projectId={project.id} projectName={project.name} canEdit={false}>
        <section className="state-page">
          <h1>Read-only project</h1>
          <p>You can view {project.name}, but only its owner can change project settings.</p>
        </section>
      </ProjectShell>
    );
  }

  const archive = async () => {
    setBusy(true);
    try {
      const response = await api.mutate(`/api/v1/projects/${projectId}/archive`, { method: "POST" }, projectResponseSchema);
      if (response !== undefined) setProject(response.project);
      setArchiveOpen(false);
      setError(null);
    } catch {
      setError("Project could not be archived.");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      const response = await api.mutate(`/api/v1/projects/${projectId}/restore`, { method: "POST" }, projectResponseSchema);
      if (response !== undefined) setProject(response.project);
      setError(null);
    } catch (restoreError) {
      setError(restoreError instanceof ApiError && restoreError.code === "PROJECT_LIMIT_REACHED"
        ? "Archive another project before restoring this one."
        : "Project could not be restored.");
    } finally {
      setBusy(false);
    }
  };

  const deleteProject = async () => {
    setBusy(true);
    try {
      await api.mutate(`/api/v1/projects/${projectId}`, { method: "DELETE", body: { confirm_name: confirmation } });
      window.location.assign("/app");
    } catch (deleteError) {
      if (deleteError instanceof ApiError && deleteError.code === "RECENT_AUTH_REQUIRED") {
        const returnTo = `/app/projects/${projectId}/settings`;
        window.location.assign(`/auth/github/start?return_to=${encodeURIComponent(returnTo)}`);
        return;
      }
      setError("Project could not be deleted.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProjectShell projectId={project.id} projectName={project.name}>
      <section className="settings-page">
        <header className="page-heading"><h1>Project settings</h1><p>Lifecycle and permanent data controls for {project.name}.</p></header>
        {error === null ? null : <Alert variant="destructive"><AlertTitle>Action failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        {project.status === "archived" ? (
          <Alert><ArchiveIcon /><AlertTitle>This project is archived.</AlertTitle><AlertDescription>MCP access is stopped and the project no longer uses an active slot.</AlertDescription></Alert>
        ) : null}
        <section className="settings-section">
          <div><h2>{project.status === "active" ? "Archive project" : "Restore project"}</h2><p>{project.status === "active" ? "Pause every MCP connection while keeping all project data." : "Return the project and its connections to active use."}</p></div>
          {project.status === "active" ? (
            <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
              <DialogTrigger asChild><Button type="button" variant="outline"><ArchiveIcon /> Archive project</Button></DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Archive {project.name}?</DialogTitle><DialogDescription>All MCP access stops immediately. You can restore the project later if an active slot is available.</DialogDescription></DialogHeader>
                <DialogFooter><Button type="button" variant="destructive" disabled={busy} onClick={() => void archive()}>Confirm archive</Button></DialogFooter>
              </DialogContent>
            </Dialog>
          ) : <Button type="button" variant="outline" disabled={busy} onClick={() => void restore()}><RotateCcwIcon /> Restore project</Button>}
        </section>
        <section className="settings-section settings-section--danger">
          <div><h2>Delete permanently</h2><p>Remove the project, connections, agents, messages, and activity. This cannot be undone in the application.</p></div>
          <Dialog open={deleteOpen} onOpenChange={(open) => {
            setDeleteOpen(open);
            if (!open) setConfirmation("");
          }}>
            <DialogTrigger asChild><Button type="button" variant="destructive"><Trash2Icon /> Delete permanently</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Delete {project.name} permanently</DialogTitle><DialogDescription>This removes every project record. Recent GitHub authentication is required.</DialogDescription></DialogHeader>
              <div className="confirmation-field"><Label htmlFor="project-confirmation">Type {project.name} to confirm</Label><Input id="project-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></div>
              <DialogFooter><Button type="button" variant="destructive" disabled={busy || confirmation !== project.name} onClick={() => void deleteProject()}>Delete project permanently</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </section>
      </section>
    </ProjectShell>
  );
}
