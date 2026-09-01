import { RefreshCwIcon, ShieldXIcon } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";

import { Brand, GitHubMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { useSession } from "@/auth/session-store";

import "./ops.css";

export function OperatorGate() {
  const { state, refresh } = useSession();
  const location = useLocation();

  if (state.status === "loading") {
    return (
      <main className="state-page" aria-label="Loading operator console">
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
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <main className="state-page">
        <Brand />
        <h1>Sign in to AgentMesh</h1>
        <p>An authenticated operator session is required to open the operator console.</p>
        <Button asChild size="lg">
          <a href={`/auth/github/start?return_to=${encodeURIComponent(returnTo)}`}>
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
        <h1>Operator console is temporarily unavailable</h1>
        <p>Your session and operator data were not changed.</p>
        <Button type="button" variant="outline" size="lg" onClick={() => void refresh()}>
          <RefreshCwIcon />
          Try again
        </Button>
      </main>
    );
  }

  if (!state.session.operator) {
    return (
      <main className="state-page">
        <ShieldXIcon className="ops-denied-icon" aria-hidden="true" />
        <p className="ops-error-code">403</p>
        <h1>Operator access required</h1>
        <p>This account is authenticated but is not on the operator allowlist.</p>
        <Button asChild variant="outline" size="lg">
          <Link to="/app">Return to workspace</Link>
        </Button>
      </main>
    );
  }

  return <Outlet />;
}
