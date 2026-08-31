import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { ApiError } from "@/api/client";
import { projectResponseSchema, type ProjectListResponse } from "@/api/schemas";
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
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface ProjectCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectList: ProjectListResponse | null;
}

function errorCopy(error: unknown): string {
  if (error instanceof ApiError && error.code === "PROJECT_LIMIT_REACHED") return "You have reached the active project limit.";
  if (error instanceof ApiError && error.code === "INVALID_REQUEST") return "Check the project details and try again.";
  return "The project could not be created. Try again.";
}

export function ProjectCreateDialog({ open, onOpenChange, projectList }: ProjectCreateDialogProps) {
  const { api } = useSession();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const atLimit = projectList !== null
    && projectList.project_limit !== 0
    && projectList.active_count >= projectList.project_limit;

  useEffect(() => {
    if (open) return;
    formRef.current?.reset();
    setSubmitError(null);
  }, [open]);

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen && submitting.current) return;
    onOpenChange(nextOpen);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || projectList === null || atLimit) return;
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
      submitting.current = false;
      setPending(false);
      onOpenChange(false);
      navigate(`/app/projects/${response.project.id}`);
    } catch (error) {
      setSubmitError(errorCopy(error));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="project-create-dialog" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Create a shared workspace for agents working on the same codebase.</DialogDescription>
        </DialogHeader>
        <form ref={formRef} className="project-dialog-form" onSubmit={(event) => void submit(event)}>
          <FieldGroup>
            <Field data-invalid={submitError !== null}>
              <FieldLabel htmlFor="new-project-name">Project name</FieldLabel>
              <Input id="new-project-name" name="name" maxLength={100} placeholder="e.g. checkout-service" aria-invalid={submitError !== null} autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-project-description">Description</FieldLabel>
              <Textarea id="new-project-description" name="description" maxLength={500} placeholder="What is this project about?" />
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
          <p className="project-limit">{projectList === null
            ? "Loading project limits…"
            : projectList.project_limit === 0
              ? `${projectList.active_count} active projects · Unlimited`
              : `${projectList.active_count} of ${projectList.project_limit} active projects`}</p>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={pending || atLimit || projectList === null}>
              {pending ? "Creating project…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
