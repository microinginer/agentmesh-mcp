import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

export function OperatorLoading({ label }: { label: string }) {
  return (
    <section className="ops-page ops-loading" aria-label={label}>
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </section>
  );
}

export function OperatorLoadError({ heading, onRetry }: { heading: string; onRetry: () => void }) {
  return (
    <section className="ops-page">
      <Empty className="ops-state">
        <EmptyHeader>
          <EmptyTitle role="heading" aria-level={1}>{heading}</EmptyTitle>
          <EmptyDescription>No operator action was performed. Retry when the control plane is reachable.</EmptyDescription>
        </EmptyHeader>
        <Button type="button" variant="outline" onClick={onRetry}>
          <RefreshCwIcon />
          Try again
        </Button>
      </Empty>
    </section>
  );
}

export function OperatorEmpty({ description, heading }: { description: string; heading: string }) {
  return (
    <Empty className="ops-state ops-state--compact">
      <EmptyHeader>
        <EmptyTitle role="heading" aria-level={2}>{heading}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function OperatorActionError({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Action failed</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function MetadataItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ops-metadata__item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function formatTimestamp(value: string | null): string {
  if (value === null) return "Never";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

export function OperatorNotFoundPage() {
  return (
    <section className="ops-page">
      <OperatorEmpty heading="Operator page not found" description="Use the operator navigation to continue." />
    </section>
  );
}
