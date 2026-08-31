import { RefreshCwIcon } from "lucide-react";
import { Outlet } from "react-router-dom";

import { Brand, GitHubMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { useSession } from "./session-store";

export function AuthGate() {
  const { state, refresh } = useSession();

  if (state.status === "loading") {
    return (
      <main className="state-page" aria-label="Loading AgentMesh">
        <Brand />
        <div className="state-page__skeletons" aria-hidden="true">
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-10 w-36" />
        </div>
      </main>
    );
  }

  if (state.status === "anonymous") {
    return (
      <main className="state-page">
        <Brand />
        <h1>Sign in to AgentMesh</h1>
        <p>Your session has ended. Continue with GitHub to return to your workspace.</p>
        <Button asChild size="lg">
          <a href="/auth/github/start?return_to=%2Fapp">
            <GitHubMark />
            Continue with GitHub
          </a>
        </Button>
      </main>
    );
  }

  if (state.status === "unavailable") {
    return (
      <main className="state-page">
        <Brand />
        <h1>AgentMesh is temporarily unavailable</h1>
        <p>Your session has not been changed. Try again when the service is reachable.</p>
        <Button type="button" variant="outline" size="lg" onClick={() => void refresh()}>
          <RefreshCwIcon data-icon="inline-start" />
          Try again
        </Button>
      </main>
    );
  }

  return <Outlet />;
}
