import { ArrowRightIcon, UserRoundIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { operatorUserListResponseSchema, type OperatorUserListResponse } from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { OperatorEmpty, OperatorLoadError, OperatorLoading } from "./operator-ui";

export function OperatorUsersPage() {
  const { api } = useSession();
  const [data, setData] = useState<OperatorUserListResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setData(null);
    try {
      setData(await api.query("/api/v1/ops/users?limit=25", operatorUserListResponseSchema));
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
        `/api/v1/ops/users?limit=25&cursor=${encodeURIComponent(data.next_cursor)}`,
        operatorUserListResponseSchema,
      );
      setData({ items: [...data.items, ...page.items], next_cursor: page.next_cursor });
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  if (data === null && !failed) return <OperatorLoading label="Loading users" />;
  if (data === null) return <OperatorLoadError heading="Users are temporarily unavailable" onRetry={() => void load()} />;

  return (
    <section className="ops-page">
      <header className="ops-page__heading">
        <div><p className="ops-eyebrow">Operator console</p><h1>Users</h1></div>
        <p>Safe account metadata and lifecycle controls. Session and credential data are never displayed.</p>
      </header>
      {failed ? <OperatorLoadError heading="More users could not be loaded" onRetry={() => void loadMore()} /> : null}
      {data.items.length === 0 ? (
        <OperatorEmpty heading="No users found" description="Users will appear after their first successful GitHub sign-in." />
      ) : (
        <ul className="ops-list" aria-label="Users">
          {data.items.map((item) => (
            <li key={item.id} className="ops-list-row">
              <Avatar size="lg">
                {item.avatar_url === null ? null : <AvatarImage src={item.avatar_url} alt="" />}
                <AvatarFallback><UserRoundIcon aria-hidden="true" /></AvatarFallback>
              </Avatar>
              <div className="ops-list-row__primary">
                <strong>{item.display_name}</strong>
                <span>@{item.github_login} · GitHub {item.github_user_id}</span>
              </div>
              <div className="ops-list-row__meta">
                <span>{item.active_project_count} active</span>
                <span>{item.project_count} projects</span>
              </div>
              <Badge variant={item.blocked_at === null ? "outline" : "destructive"}>
                {item.blocked_at === null ? "Active" : "Blocked"}
              </Badge>
              <Link className="ops-row-link" to={`/ops/users/${item.id}`} aria-label={`View ${item.display_name}`}>
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data.next_cursor === null ? null : (
        <div className="ops-load-more">
          <Button type="button" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading users…" : "Load more users"}
          </Button>
        </div>
      )}
    </section>
  );
}
