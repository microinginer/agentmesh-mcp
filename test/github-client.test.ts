import { describe, expect, it } from "vitest";

import {
  GitHubOAuthError,
  createGitHubClient,
} from "../src/web-auth/github-client.js";

const callbackUrl = new URL("https://agentmesh.example/auth/github/callback");
const fakeAccessToken = "ephemeral-access-token-that-must-not-leak";
const fakeProviderBody = "provider-body-that-must-not-leak";

function responseJson(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

describe("GitHub OAuth client", () => {
  it("builds a no-scope authorization URL with the OAuth state and PKCE challenge", () => {
    const client = createGitHubClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl,
    });

    const url = client.authorizationUrl("state-value", "pkce-challenge");

    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(callbackUrl.toString());
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("exchanges a code using the configured callback and PKCE verifier", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl,
      endpoints: { token: "https://github.example.test/login/oauth/access_token" },
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return responseJson({ access_token: fakeAccessToken, scope: "" });
      },
    });

    await expect(client.exchangeCode("oauth-code", "pkce-verifier")).resolves.toBe(fakeAccessToken);

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.headers.get("accept")).toBe("application/json");
    const body = await request.formData();
    expect(Object.fromEntries(body.entries())).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      code: "oauth-code",
      code_verifier: "pkce-verifier",
      redirect_uri: callbackUrl.toString(),
    });
  });

  it("fails closed on a prior GitHub grant without leaking its scope or provider body", async () => {
    let fetches = 0;
    const client = createGitHubClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl,
      fetchImpl: async () => {
        fetches += 1;
        return responseJson({
          access_token: fakeAccessToken,
          scope: "repo user",
          detail: fakeProviderBody,
        });
      },
    });

    const error = await client.exchangeCode("oauth-code", "pkce-verifier").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubOAuthError);
    expect(error).toMatchObject({ code: "GITHUB_OAUTH_SCOPE_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(fakeAccessToken);
    expect(JSON.stringify(error)).not.toContain("repo user");
    expect(JSON.stringify(error)).not.toContain(fakeProviderBody);
    expect(String(error)).not.toContain(fakeAccessToken);
    expect(String(error)).not.toContain("repo user");
    expect(String(error)).not.toContain(fakeProviderBody);
    expect(fetches).toBe(1);
  });

  it.each([
    ["string", "42"],
    ["zero", 0],
    ["negative", -42],
    ["fractional", 42.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s GitHub profile id", async (_label, id) => {
    const client = createGitHubClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl,
      fetchImpl: async () => responseJson({ id, login: "octocat", name: null, avatar_url: null }),
    });

    await expect(client.fetchProfile(fakeAccessToken)).rejects.toMatchObject({
      code: "GITHUB_PROFILE_INVALID",
    });
  });

  it("normalizes a positive numeric GitHub profile and sends the documented request headers", async () => {
    const requests: Request[] = [];
    const client = createGitHubClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl,
      endpoints: { profile: "https://github.example.test/user" },
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return responseJson({
          id: 42,
          login: "octocat",
          name: "Octo Cat",
          avatar_url: "https://avatars.githubusercontent.com/u/42?v=4",
        });
      },
    });

    await expect(client.fetchProfile(fakeAccessToken)).resolves.toEqual({
      id: "42",
      login: "octocat",
      name: "Octo Cat",
      avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
    });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.headers.get("accept")).toBe("application/vnd.github+json");
    expect(request.headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(request.headers.get("authorization")).toBe(`Bearer ${fakeAccessToken}`);
    expect(request.headers.get("user-agent")).toBe("AgentMesh/1.0");
  });

  it.each([
    ["blank login", { id: 42, login: "", name: null, avatar_url: null }],
    ["overlong login", { id: 42, login: "a".repeat(101), name: null, avatar_url: null }],
    ["blank name", { id: 42, login: "octocat", name: "", avatar_url: null }],
    ["overlong name", { id: 42, login: "octocat", name: "a".repeat(101), avatar_url: null }],
    ["insecure avatar", { id: 42, login: "octocat", name: null, avatar_url: "http://example.test/a.png" }],
  ])("rejects a profile with %s", async (_label, body) => {
    const client = createGitHubClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl,
      fetchImpl: async () => responseJson(body),
    });

    await expect(client.fetchProfile(fakeAccessToken)).rejects.toMatchObject({
      code: "GITHUB_PROFILE_INVALID",
    });
  });

  it("uses safe typed errors for non-success and malformed provider responses", async () => {
    const client = createGitHubClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl,
      fetchImpl: async () => new Response(fakeProviderBody, { status: 502 }),
    });

    const error = await client.fetchProfile(fakeAccessToken).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubOAuthError);
    expect(error).toMatchObject({ code: "GITHUB_PROFILE_REQUEST_FAILED" });
    expect(JSON.stringify(error)).not.toContain(fakeAccessToken);
    expect(JSON.stringify(error)).not.toContain(fakeProviderBody);
    expect(String(error)).not.toContain(fakeAccessToken);
    expect(String(error)).not.toContain(fakeProviderBody);
  });
});
