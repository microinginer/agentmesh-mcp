import type { ReactNode } from "react";

import type { Project } from "@/api/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectShell } from "@/projects/project-shell";

export function ActivityFrame({
  project,
  title,
  description,
  loading,
  stale,
  error,
  empty,
  nextCursor,
  onLoadMore,
  children,
}: {
  project: Project | null;
  title: string;
  description: string;
  loading: boolean;
  stale: boolean;
  error: string | null;
  empty: string;
  nextCursor: string | null;
  onLoadMore: () => Promise<void>;
  children: ReactNode;
}) {
  if (loading) {
    return <section className="activity-page activity-page--loading" aria-label={`Loading ${title.toLowerCase()}`}><Skeleton className="h-10 w-60" /><Skeleton className="h-64 w-full" /></section>;
  }
  if (project === null || error !== null) {
    return <section className="state-page"><h1>{title} unavailable</h1><p>{error ?? "Project was not found."}</p></section>;
  }
  return (
    <ProjectShell projectId={project.id} projectName={project.name}>
      <section className="activity-page">
        <header className="page-heading"><h1>{title}</h1><p>{description}</p></header>
        {stale ? <Alert><AlertTitle>Reconnecting</AlertTitle><AlertDescription>Showing the last successful update while AgentMesh reconnects.</AlertDescription></Alert> : null}
        {children === null ? (
          <Empty className="workspace-empty workspace-empty--bordered"><EmptyHeader><EmptyTitle>Nothing here yet</EmptyTitle><EmptyDescription>{empty}</EmptyDescription></EmptyHeader></Empty>
        ) : children}
        {nextCursor === null ? null : <div className="load-more"><Button type="button" variant="outline" onClick={() => void onLoadMore()}>Load more</Button></div>}
      </section>
    </ProjectShell>
  );
}
