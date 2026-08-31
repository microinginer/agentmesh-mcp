import type { ReactElement, ReactNode } from "react";

export interface ProjectOverviewFixtureProps {
  children?: ReactNode;
}

export function ProjectOverviewFixture({ children }: ProjectOverviewFixtureProps): ReactElement {
  return <main aria-label="Project overview fixture">{children}</main>;
}

export function MessagesPageFixture({ text }: { text: string }): ReactElement {
  return <main aria-label="Messages fixture">{text}</main>;
}
