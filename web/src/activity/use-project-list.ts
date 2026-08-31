import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";

import { projectResponseSchema, type Project } from "@/api/schemas";
import { useSession } from "@/auth/session-store";

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

interface ProjectListState<T> {
  project: Project | null;
  items: T[];
  nextCursor: string | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useProjectList<T>(
  projectId: string,
  resource: string,
  schema: z.ZodType<Page<T>>,
): ProjectListState<T> {
  const { api } = useSession();
  const [project, setProject] = useState<Project | null>(null);
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const basePath = `/api/v1/projects/${projectId}/${resource}`;

  const applyPage = useCallback((page: Page<T>, append: boolean) => {
    setItems((current) => append ? [...current, ...page.items] : page.items);
    setNextCursor(page.next_cursor);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([
      api.query(`/api/v1/projects/${projectId}`, projectResponseSchema),
      api.query(`${basePath}?limit=50`, schema),
    ]).then(([projectResponse, page]) => {
      if (!active) return;
      setProject(projectResponse.project);
      applyPage(page, false);
      setError(null);
    }).catch(() => {
      if (active) setError("This project view is temporarily unavailable.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [api, applyPage, basePath, projectId, schema]);

  const refresh = useCallback(async () => {
    try {
      const page = await api.query(`${basePath}?limit=50`, schema);
      applyPage(page, false);
      setStale(false);
    } catch (refreshError) {
      setStale(true);
      throw refreshError;
    }
  }, [api, applyPage, basePath, schema]);

  const loadMore = useCallback(async () => {
    if (nextCursor === null) return;
    const page = await api.query(`${basePath}?limit=50&cursor=${encodeURIComponent(nextCursor)}`, schema);
    applyPage(page, true);
  }, [api, applyPage, basePath, nextCursor, schema]);

  return { project, items, nextCursor, loading, stale, error, loadMore, refresh };
}
