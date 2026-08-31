import {
  ActivityIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  FolderKanbanIcon,
  FolderPlusIcon,
  LayoutDashboardIcon,
  LinkIcon,
  LogOutIcon,
  MenuIcon,
  MessageCircleIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { projectListResponseSchema, type ProjectListResponse } from "@/api/schemas";
import { useSession } from "@/auth/session-store";
import { Brand } from "@/components/brand";
import { useTheme, type ThemePreference } from "@/components/theme-provider";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { ProjectCreateDialog } from "./project-create-dialog";

interface ShellProps {
  children: ReactNode;
  projectId?: string;
  projectName?: string;
}

const themeLabels: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function AccountMenu() {
  const { api, state } = useSession();
  const { theme, resolvedTheme, setTheme } = useTheme();
  if (state.status !== "authenticated") return null;
  const initials = state.session.user.display_name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="account-trigger">
          <Avatar>
            {state.session.user.avatar_url === null ? null : (
              <AvatarImage src={state.session.user.avatar_url} alt="" />
            )}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <span>{state.session.user.display_name}</span>
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{state.session.user.login}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemePreference)}>
            {(["system", "light", "dark"] as const).map((value) => (
              <DropdownMenuRadioItem key={value} value={value}>{themeLabels[value]}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => {
            void api.mutate("/api/v1/session", { method: "DELETE" }).finally(() => window.location.assign("/"));
          }}>
            <LogOutIcon />
            Log out
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <span className="sr-only">Current theme {resolvedTheme}</span>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Navigation({ projectId }: { projectId?: string }) {
  const location = useLocation();
  if (projectId === undefined) {
    return (
      <nav className="workspace-nav" aria-label="Workspace navigation">
        <Link className="workspace-nav__link workspace-nav__link--active" to="/app">
          <FolderKanbanIcon /> Projects
        </Link>
      </nav>
    );
  }
  const base = `/app/projects/${projectId}`;
  const items = [
    { to: base, label: "Overview", icon: LayoutDashboardIcon, exact: true },
    { to: `${base}/agents`, label: "Agents", icon: BotIcon },
    { to: `${base}/messages`, label: "Messages", icon: MessageCircleIcon },
    { to: `${base}/activity`, label: "Activity", icon: ActivityIcon },
    { to: `${base}/connections`, label: "Connections", icon: LinkIcon },
    { to: `${base}/settings`, label: "Settings", icon: SettingsIcon },
  ];
  return (
    <nav className="workspace-nav" aria-label="Project navigation">
      {items.map(({ to, label, icon: Icon, exact }) => {
        const active = exact ? location.pathname === base : location.pathname === to;
        return (
          <Link key={label} className={cn("workspace-nav__link", active && "workspace-nav__link--active")} to={to}>
            <Icon /> {label}
          </Link>
        );
      })}
    </nav>
  );
}

function projectDestination(pathname: string, projectId: string): string {
  const match = pathname.match(/^\/app\/projects\/[^/]+(\/(?:agents|messages|activity|connections|settings))?\/?$/);
  return `/app/projects/${projectId}${match?.[1] ?? ""}`;
}

function ProjectSwitcher({ projectId, projectName = "Projects" }: { projectId?: string; projectName?: string }) {
  const { api } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [data, setData] = useState<ProjectListResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const loadProjects = useCallback(async () => {
    setLoadFailed(false);
    try {
      setData(await api.query("/api/v1/projects?limit=50", projectListResponseSchema));
    } catch {
      setLoadFailed(true);
    }
  }, [api]);

  const activeProjects = data?.projects.filter((project) => project.status === "active") ?? [];
  const archivedProjects = data?.projects.filter((project) => project.status === "archived") ?? [];

  return (
    <>
      <DropdownMenu onOpenChange={(open) => { if (open) void loadProjects(); }}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" className="project-switcher" aria-label={`Current project: ${projectName}`}>
            <FolderKanbanIcon />
            <span>{projectName}</span>
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="project-switcher-menu">
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <FolderPlusIcon />
            <span>New project</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {loadFailed ? <DropdownMenuItem disabled>Projects are unavailable</DropdownMenuItem> : null}
          {!loadFailed && data === null ? <DropdownMenuItem disabled>Loading projects…</DropdownMenuItem> : null}
          {activeProjects.length === 0 || data === null ? null : (
            <DropdownMenuGroup>
              <DropdownMenuLabel className="project-switcher-menu__label">Active projects</DropdownMenuLabel>
              {activeProjects.map((project) => (
                <DropdownMenuItem key={project.id} onSelect={() => navigate(projectDestination(location.pathname, project.id))}>
                  <FolderKanbanIcon />
                  <span>{project.name}</span>
                  {project.id === projectId ? <CheckIcon className="project-switcher-menu__check" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          )}
          {archivedProjects.length === 0 ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="project-switcher-menu__label">Archived projects</DropdownMenuLabel>
                {archivedProjects.map((project) => (
                  <DropdownMenuItem key={project.id} onSelect={() => navigate(`/app/projects/${project.id}/settings`)}>
                    <FolderKanbanIcon />
                    <span>{project.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ProjectCreateDialog open={createOpen} onOpenChange={setCreateOpen} projectList={data} />
    </>
  );
}

export function ProjectShell({ children, projectId, projectName }: ShellProps) {
  return (
    <div className="workspace-shell">
      <aside className="workspace-rail">
        <Brand linked />
        <ProjectSwitcher {...(projectId === undefined ? {} : { projectId })} {...(projectName === undefined ? {} : { projectName })} />
        <Navigation {...(projectId === undefined ? {} : { projectId })} />
        <div className="workspace-rail__account"><AccountMenu /></div>
      </aside>
      <header className="mobile-header">
        <Brand linked compact />
        <ProjectSwitcher {...(projectId === undefined ? {} : { projectId })} {...(projectName === undefined ? {} : { projectName })} />
        <Sheet>
          <SheetTrigger asChild>
            <Button type="button" variant="outline" size="icon-lg" aria-label="Open navigation">
              <MenuIcon />
            </Button>
          </SheetTrigger>
          <SheetContent className="mobile-sheet">
            <SheetHeader>
              <SheetTitle>AgentMesh navigation</SheetTitle>
              <SheetDescription>Move between your project workspace and account controls.</SheetDescription>
            </SheetHeader>
            <Navigation {...(projectId === undefined ? {} : { projectId })} />
            <Separator />
            <div className="mobile-sheet__account"><AccountMenu /></div>
          </SheetContent>
        </Sheet>
      </header>
      <main className="workspace-main">{children}</main>
    </div>
  );
}
