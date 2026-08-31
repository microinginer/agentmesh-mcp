import {
  ActivityIcon,
  BotIcon,
  ChevronDownIcon,
  FolderKanbanIcon,
  LayoutDashboardIcon,
  LinkIcon,
  LogOutIcon,
  MenuIcon,
  MessageCircleIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

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
    { to: `${base}#agents`, label: "Agents", icon: BotIcon },
    { to: `${base}#messages`, label: "Messages", icon: MessageCircleIcon },
    { to: `${base}#activity`, label: "Activity", icon: ActivityIcon },
    { to: `${base}/connections`, label: "Connections", icon: LinkIcon },
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

function ProjectSwitcher({ projectName = "Projects" }: { projectName?: string }) {
  return (
    <Link className="project-switcher" to="/app">
      <FolderKanbanIcon />
      <span>{projectName}</span>
      <ChevronDownIcon />
    </Link>
  );
}

export function ProjectShell({ children, projectId, projectName }: ShellProps) {
  return (
    <div className="workspace-shell">
      <aside className="workspace-rail">
        <Brand linked />
        <ProjectSwitcher {...(projectName === undefined ? {} : { projectName })} />
        <Navigation {...(projectId === undefined ? {} : { projectId })} />
        <div className="workspace-rail__account"><AccountMenu /></div>
      </aside>
      <header className="mobile-header">
        <Brand linked compact />
        <ProjectSwitcher {...(projectName === undefined ? {} : { projectName })} />
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
