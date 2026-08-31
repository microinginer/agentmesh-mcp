# Security policy

## Supported versions

AgentMesh is in alpha. Security fixes are applied to the latest commit on
`main` until the first stable release is published.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory form:

https://github.com/microinginer/agentmesh-mcp/security/advisories/new

Include the affected version or commit, impact, reproduction steps, and any
suggested remediation. Do not include real project tokens or user data.

We aim to acknowledge a complete report within five business days. We will
coordinate disclosure after a fix is available and credit reporters who want
to be named.

## Credential handling

AgentMesh project tokens are bearer credentials. Keep them in environment
variables or a secrets manager. Never place them in a repository, prompt,
issue, screenshot, `AGENTS.md`, or `.mcp.json`.
