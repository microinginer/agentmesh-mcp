import { ArrowRightIcon, FolderKanbanIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { operatorProjectListResponseSchema, type OperatorProjectListResponse } from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { OperatorEmpty, OperatorLoadError, OperatorLoading } from "./operator-ui";

export function OperatorProjectsPage() {
  const { api } = useSession();
  const [data, setData] = useState<OperatorProjectListResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setData(null);
    try {
      setData(await api.query("/api/v1/ops/projects?limit=25", operatorProjectListResponseSchema));
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    if (data?.next_cursor === null || data === null || loadingMore) return;
    setLoadingMore(true);
    setFailed(false);
    try {
      const page = await api.query(
        `/api/v1/ops/projects?limit=25&cursor=${encodeURIComponent(data.next_cursor)}`,
        operatorProjectListResponseSchema,
      );
      setData({ items: [...data.items, ...page.items], next_cursor: page.next_cursor });
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  if (data === null && !failed) return <OperatorLoading label="Loading projects" />;
  if (data === null) return <OperatorLoadError heading="Projects are temporarily unavailable" onRetry={() => void load()} />;

  return (
    <section className="ops-page">
      <header className="ops-page__heading">
        <div><p className="ops-eyebrow">Operator console</p><h1>Projects</h1></div>
        <p>Lifecycle, ownership, and aggregate counters only. Messages and connection credentials are excluded.</p>
      </header>
      {failed ? <OperatorLoadError heading="More projects could not be loaded" onRetry={() => void loadMore()} /> : null}
      {data.items.length === 0 ? (
        <OperatorEmpty heading="No projects found" description="Projects will appear after an owner creates one." />
      ) : (
        <ul className="ops-list" aria-label="Projects">
          {data.items.map((item) => (
            <li key={item.id} className="ops-list-row">
              <span className="ops-list-row__icon"><FolderKanbanIcon aria-hidden="true" /></span>
              <div className="ops-list-row__primary">
                <strong>{item.name}</strong>
                <span>{item.owner?.display_name ?? "No owner"}</span>
              </div>
              <div className="ops-list-row__meta">
                <span>{item.counts.agents} agents</span>
                <span>{item.counts.messages} messages</span>
              </div>
              <Badge variant={item.status === "active" ? "outline" : "secondary"}>
                {item.status === "active" ? "Active" : "Archived"}
              </Badge>
              <Link className="ops-row-link" to={`/ops/projects/${item.id}`} aria-label={`View ${item.name}`}>
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data.next_cursor === null ? null : (
        <div className="ops-load-more">
          <Button type="button" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading projects…" : "Load more projects"}
          </Button>
        </div>
      )}
    </section>
  );
}
