import { FolderKanbanIcon, ShieldCheckIcon, UsersIcon } from "lucide-react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { useSession } from "@/auth/session-store";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const links = [
  { to: "/ops/users", label: "Users", icon: UsersIcon },
  { to: "/ops/projects", label: "Projects", icon: FolderKanbanIcon },
];

function OperatorNavigation({ label: navigationLabel }: { label: string }) {
  return (
    <nav className="ops-nav" aria-label={navigationLabel}>
      {links.map(({ icon: Icon, label, to }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => cn("ops-nav__link", isActive && "ops-nav__link--active")}
        >
          <Icon aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function OperatorShell() {
  const { state } = useSession();
  const session = state.status === "authenticated" ? state.session : null;

  return (
    <div className="ops-shell">
      <aside className="ops-rail">
        <Link to="/ops" className="ops-brand" aria-label="AgentMesh operator home">
          <Brand />
          <Badge variant="outline">Operator</Badge>
        </Link>
        <OperatorNavigation label="Operator navigation" />
        <div className="ops-account">
          <span>{session?.user.display_name}</span>
          <small>@{session?.user.login}</small>
          <Link to="/app">Owner workspace</Link>
        </div>
      </aside>
      <header className="ops-mobile-header">
        <Link to="/ops" aria-label="AgentMesh operator home"><ShieldCheckIcon aria-hidden="true" /></Link>
        <OperatorNavigation label="Mobile operator navigation" />
        <Link to="/app">Workspace</Link>
      </header>
      <main className="ops-main" aria-label="AgentMesh operations">
        <Outlet />
      </main>
    </div>
  );
}
