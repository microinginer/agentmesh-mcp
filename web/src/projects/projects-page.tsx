import { ArrowRightIcon, FolderPlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ApiError } from "@/api/client";
import { projectListResponseSchema, projectResponseSchema, type ProjectListResponse } from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

import { ProjectShell } from "./project-shell";

function errorCopy(error: unknown): string {
  if (error instanceof ApiError && error.code === "PROJECT_LIMIT_REACHED") return "You have reached the active project limit.";
  if (error instanceof ApiError && error.code === "INVALID_REQUEST") return "Check the project details and try again.";
  return "The project could not be created. Try again.";
}

export function ProjectsPage() {
  const { api } = useSession();
  const navigate = useNavigate();
  const [data, setData] = useState<ProjectListResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setData(await api.query("/api/v2/projects?limit=50", projectListResponseSchema));
    } catch {
      setLoadError(true);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const firstActiveProject = data?.default_project ?? data?.projects.find((item) => item.status === "active") ?? null;
  useEffect(() => {
    if (firstActiveProject !== null) {
      navigate(`/app/projects/${firstActiveProject.id}`, { replace: true });
    }
  }, [firstActiveProject, navigate]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      submitting.current
      || data === null
      || (data.project_limit !== 0 && data.active_count >= data.project_limit)
    ) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    if (name.length === 0) {
      setSubmitError("Project name is required.");
      return;
    }
    submitting.current = true;
    setPending(true);
    setSubmitError(null);
    try {
      const response = await api.mutate("/api/v1/projects", {
        method: "POST",
        body: { name, description: description.length === 0 ? null : description },
        idempotencyKey: crypto.randomUUID(),
      }, projectResponseSchema);
      if (response === undefined) throw new Error("Missing project response");
      navigate(`/app/projects/${response.project.id}`);
    } catch (error) {
      setSubmitError(errorCopy(error));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  if (data === null && !loadError) {
    return (
      <ProjectShell>
        <section className="projects-loading" aria-label="Loading projects">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-48 w-full max-w-2xl" />
        </section>
      </ProjectShell>
    );
  }

  if (loadError || data === null) {
    return (
      <ProjectShell>
        <Empty className="workspace-empty">
          <EmptyHeader>
            <EmptyTitle>Projects are temporarily unavailable</EmptyTitle>
            <EmptyDescription>Your workspace was not changed.</EmptyDescription>
          </EmptyHeader>
          <Button type="button" variant="outline" onClick={() => void load()}>Try again</Button>
        </Empty>
      </ProjectShell>
    );
  }

  if (firstActiveProject !== null) {
    return (
      <ProjectShell projectId={firstActiveProject.id} projectName={firstActiveProject.name}>
        <section className="projects-loading" aria-label="Opening project">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-48 w-full max-w-2xl" />
        </section>
      </ProjectShell>
    );
  }

  const atLimit = data.project_limit !== 0 && data.active_count >= data.project_limit;
  const isFirstProject = data.projects.length === 0;
  return (
    <ProjectShell>
      <section className={isFirstProject ? "onboarding" : "projects-page"}>
        <header className="projects-page__header">
          {isFirstProject ? <EmptyMedia variant="icon"><FolderPlusIcon /></EmptyMedia> : null}
          <h1>{isFirstProject ? "Create your first project" : "Projects"}</h1>
          <p>{isFirstProject
            ? "A project gives your agents one shared workspace for context, messages, and activity."
            : "Choose a shared workspace or create another project."}</p>
        </header>

        {isFirstProject ? null : (
          <div className="project-list" role="list" aria-label="Projects">
            {data.projects.map((item) => (
              <Link key={item.id} className="project-row" role="listitem" to={`/app/projects/${item.id}`}>
                <span><strong>{item.name}</strong><small>{item.description ?? "No description"}</small></span>
                <span className={`status-text status-text--${item.status}`}>{item.status}</span>
                <ArrowRightIcon />
              </Link>
            ))}
          </div>
        )}

        <form className="project-form" onSubmit={(event) => void submit(event)}>
          <FieldGroup>
            <Field data-invalid={submitError !== null}>
              <FieldLabel htmlFor="project-name">Project name</FieldLabel>
              <Input id="project-name" name="name" maxLength={100} placeholder="e.g. checkout-service" aria-invalid={submitError !== null} />
            </Field>
            <Field>
              <FieldLabel htmlFor="project-description">Description</FieldLabel>
              <Textarea id="project-description" name="description" maxLength={500} placeholder="What is this project about?" />
              <FieldDescription>Optional</FieldDescription>
            </Field>
            {submitError === null ? null : <FieldError>{submitError}</FieldError>}
          </FieldGroup>
          {atLimit ? (
            <Alert>
              <AlertTitle>Project limit reached</AlertTitle>
              <AlertDescription>Archive an active project before creating another.</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" size="lg" disabled={pending || atLimit}>
            {pending ? "Creating project…" : "Create project"}
          </Button>
          <p className="project-limit">{data.project_limit === 0
            ? `${data.active_count} active projects · Unlimited`
            : `${data.active_count} of ${data.project_limit} active projects`}</p>
        </form>
      </section>
    </ProjectShell>
  );
}
