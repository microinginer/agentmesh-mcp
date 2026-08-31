import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";

export function MeshMark({ className }: { className?: string }) {
  return (
    <svg className={cn("mesh-mark", className)} viewBox="0 0 36 36" aria-hidden="true">
      <path d="M18 18 8.5 9.5M18 18l9.5-8.5M18 18v11" />
      <circle cx="8.5" cy="9.5" r="3" />
      <circle cx="27.5" cy="9.5" r="3" />
      <circle cx="18" cy="29" r="3" />
      <circle cx="18" cy="18" r="4" />
    </svg>
  );
}

export function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.57 9.57 0 0 1 12 6.82a9.5 9.5 0 0 1 2.5.34c1.9-1.29 2.74-1.02 2.74-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.77c0 .26.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}

export function Brand({ linked = false, compact = false }: { linked?: boolean; compact?: boolean }) {
  const content = (
    <span className={cn("brand", compact && "brand--compact")}>
      <MeshMark />
      <span>AgentMesh</span>
    </span>
  );
  return linked ? <Link to="/app" aria-label="AgentMesh home">{content}</Link> : content;
}
