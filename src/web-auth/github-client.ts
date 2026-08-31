import { z } from "zod";

const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_USER_AGENT = "AgentMesh/1.0";

const defaultEndpoints = {
  authorization: "https://github.com/login/oauth/authorize",
  token: "https://github.com/login/oauth/access_token",
  profile: "https://api.github.com/user",
} as const;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().optional(),
}).passthrough();

const profileResponseSchema = z.object({
  id: z.number().refine(
    (value) => Number.isSafeInteger(value) && value > 0,
    "GitHub id must be a positive safe integer",
  ),
  login: z.string().min(1).max(100),
  name: z.string().min(1).max(100).nullable(),
  avatar_url: z.string().url().max(2_048).refine(
    (value) => new URL(value).protocol === "https:",
    "GitHub avatar must use HTTPS",
  ).nullable(),
}).passthrough();

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitHubProfile {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubOAuthClient {
  authorizationUrl(state: string, challenge: string): URL;
  exchangeCode(code: string, verifier: string): Promise<string>;
  fetchProfile(accessToken: string): Promise<GitHubProfile>;
}

export class GitHubOAuthError extends Error {
  constructor(public readonly code: GitHubOAuthErrorCode) {
    super(githubOAuthErrorMessage(code));
    this.name = "GitHubOAuthError";
  }
}

export type GitHubOAuthErrorCode =
  | "GITHUB_OAUTH_EXCHANGE_FAILED"
  | "GITHUB_OAUTH_RESPONSE_INVALID"
  | "GITHUB_OAUTH_SCOPE_REJECTED"
  | "GITHUB_PROFILE_REQUEST_FAILED"
  | "GITHUB_PROFILE_INVALID";

export interface GitHubOAuthEndpoints {
  authorization?: string | URL;
  token?: string | URL;
  profile?: string | URL;
}

export interface CreateGitHubClientInput {
  clientId: string;
  clientSecret: string;
  callbackUrl: URL;
  fetchImpl?: FetchLike;
  endpoints?: GitHubOAuthEndpoints;
}

function githubOAuthErrorMessage(code: GitHubOAuthErrorCode): string {
  switch (code) {
    case "GITHUB_OAUTH_EXCHANGE_FAILED":
      return "GitHub authorization exchange failed";
    case "GITHUB_OAUTH_RESPONSE_INVALID":
      return "GitHub authorization response was invalid";
    case "GITHUB_OAUTH_SCOPE_REJECTED":
      return "GitHub authorization returned unsupported permissions";
    case "GITHUB_PROFILE_REQUEST_FAILED":
      return "GitHub profile request failed";
    case "GITHUB_PROFILE_INVALID":
      return "Invalid GitHub profile";
  }
}

function endpointUrl(value: string | URL): URL {
  return new URL(value);
}

function safeFetch(fetchImpl: FetchLike, input: string | URL, init: RequestInit, code: GitHubOAuthErrorCode): Promise<Response> {
  return fetchImpl(input, init).catch(() => {
    throw new GitHubOAuthError(code);
  });
}

export function createGitHubClient(input: CreateGitHubClientInput): GitHubOAuthClient {
  const endpoints = {
    authorization: endpointUrl(input.endpoints?.authorization ?? defaultEndpoints.authorization),
    token: endpointUrl(input.endpoints?.token ?? defaultEndpoints.token),
    profile: endpointUrl(input.endpoints?.profile ?? defaultEndpoints.profile),
  };
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    authorizationUrl(state: string, challenge: string): URL {
      const url = new URL(endpoints.authorization);
      url.searchParams.set("client_id", input.clientId);
      url.searchParams.set("redirect_uri", input.callbackUrl.toString());
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url;
    },

    async exchangeCode(code: string, verifier: string): Promise<string> {
      const body = new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code,
        redirect_uri: input.callbackUrl.toString(),
        code_verifier: verifier,
      });
      const response = await safeFetch(fetchImpl, endpoints.token, {
        method: "POST",
        headers: { Accept: "application/json" },
        body,
      }, "GITHUB_OAUTH_EXCHANGE_FAILED");
      if (!response.ok) {
        throw new GitHubOAuthError("GITHUB_OAUTH_EXCHANGE_FAILED");
      }

      let parsed: z.infer<typeof tokenResponseSchema>;
      try {
        parsed = tokenResponseSchema.parse(await response.json());
      } catch {
        throw new GitHubOAuthError("GITHUB_OAUTH_RESPONSE_INVALID");
      }
      if (parsed.scope !== undefined && parsed.scope.trim().length > 0) {
        throw new GitHubOAuthError("GITHUB_OAUTH_SCOPE_REJECTED");
      }
      return parsed.access_token;
    },

    async fetchProfile(accessToken: string): Promise<GitHubProfile> {
      const response = await safeFetch(fetchImpl, endpoints.profile, {
        headers: {
          Accept: GITHUB_ACCEPT,
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": GITHUB_USER_AGENT,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      }, "GITHUB_PROFILE_REQUEST_FAILED");
      if (!response.ok) {
        throw new GitHubOAuthError("GITHUB_PROFILE_REQUEST_FAILED");
      }

      let parsed: z.infer<typeof profileResponseSchema>;
      try {
        parsed = profileResponseSchema.parse(await response.json());
      } catch {
        throw new GitHubOAuthError("GITHUB_PROFILE_INVALID");
      }
      return {
        id: parsed.id.toString(10),
        login: parsed.login,
        name: parsed.name,
        avatarUrl: parsed.avatar_url,
      };
    },
  };
}
