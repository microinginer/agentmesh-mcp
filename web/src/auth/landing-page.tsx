import { MoonIcon, SunIcon } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { Brand, GitHubMark, MeshMark } from "@/components/brand";
import { useTheme } from "@/components/theme-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function LandingPage() {
  const [searchParams] = useSearchParams();
  const { resolvedTheme, setTheme } = useTheme();
  const authFailed = searchParams.get("auth_error") === "github";

  return (
    <main className="landing">
      <header className="landing__header">
        <Brand />
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Use ${resolvedTheme === "light" ? "dark" : "light"} theme`}
          onClick={() => setTheme(resolvedTheme === "light" ? "dark" : "light")}
        >
          {resolvedTheme === "light" ? <SunIcon data-icon="inline-start" /> : <MoonIcon data-icon="inline-start" />}
          {resolvedTheme === "light" ? "Light" : "Dark"}
        </Button>
      </header>
      <section className="landing__copy">
        <h1>Your agents, working as <span>one.</span></h1>
        <p>Share project context, coordinate work, and keep every coding agent aligned.</p>
        {authFailed ? (
          <Alert variant="destructive">
            <AlertTitle>GitHub sign-in was not completed</AlertTitle>
            <AlertDescription>Please try again.</AlertDescription>
          </Alert>
        ) : null}
        <Button asChild size="lg" className="landing__github">
          <a href="/auth/github/start">
            <GitHubMark />
            Continue with GitHub
          </a>
        </Button>
        <div className="landing__identity-note">
          <MeshMark />
          <p>We use GitHub for identity only. Repository access is not requested.</p>
        </div>
      </section>
      <section className="landing__preview" aria-label="Shared agent workspace preview">
        <div className="preview__heading">
          <span>acme/checkout-service</span>
          <span className="preview__status">Synced</span>
        </div>
        <p>One project. Shared context. Coordinated agents.</p>
        <article className="agent-preview">
          <strong>Agent: codex-laptop</strong>
          <span>Editing</span>
          <code>return charge(total);</code>
          <code className="agent-preview__change">+ return await charge(total, &#123; idempotent: true &#125;);</code>
        </article>
        <div className="preview__shared"><MeshMark />Context &amp; messages shared</div>
        <article className="agent-preview">
          <strong>Agent: claude-desktop</strong>
          <span>Reviewing</span>
          <code>headers['Idempotency-Key'] = key;</code>
        </article>
      </section>
    </main>
  );
}
