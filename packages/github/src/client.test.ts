import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeGitHubApiClient } from "./client.ts";
import { redactGitHubSecrets } from "./redaction.ts";

const octokitMocks = vi.hoisted(() => ({
  getAuthenticated: vi.fn(),
  listForAuthenticatedUser: vi.fn(),
  paginate: vi.fn(),
  getRepository: vi.fn(),
  constructorOptions: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    readonly rest = {
      users: { getAuthenticated: octokitMocks.getAuthenticated },
      repos: {
        listForAuthenticatedUser: octokitMocks.listForAuthenticatedUser,
        get: octokitMocks.getRepository,
      },
    };

    constructor(options: unknown) {
      octokitMocks.constructorOptions(options);
    }

    readonly paginate = octokitMocks.paginate;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const repository = {
  id: 42,
  name: "private-repo",
  full_name: "octocat/private-repo",
  description: "T3 project",
  html_url: "https://github.com/octocat/private-repo",
  clone_url: "https://github.com/octocat/private-repo.git",
  ssh_url: "git@github.com:octocat/private-repo.git",
  default_branch: "main",
  private: true,
  archived: false,
  pushed_at: "2026-01-01T00:00:00Z",
};

describe("GitHub API client", () => {
  it("validates an account and never places the token in repository URLs", async () => {
    octokitMocks.getAuthenticated.mockResolvedValue({
      data: {
        login: "octocat",
        name: "Octo Cat",
        avatar_url: "https://avatars.example/octocat",
        html_url: "https://github.com/octocat",
      },
    });
    const token = "github_pat_test-private";
    const client = makeGitHubApiClient({ token });

    await expect(client.getAccount()).resolves.toMatchObject({ login: "octocat" });
    expect(octokitMocks.constructorOptions).toHaveBeenCalledWith(
      expect.objectContaining({ auth: token, userAgent: "t3-code" }),
    );
  });

  it("lists and searches accessible private repositories with normalized metadata", async () => {
    octokitMocks.paginate.mockResolvedValue([
      repository,
      { ...repository, id: 43, full_name: "octocat/private-second" },
      { ...repository, id: 44, full_name: "octocat/unrelated" },
    ]);
    const client = makeGitHubApiClient({ token: "github_pat_test" });

    await expect(
      client.listRepositories({ query: "PRIVATE", page: 1, perPage: 1 }),
    ).resolves.toEqual({
      repositories: [
        expect.objectContaining({
          id: 42,
          nameWithOwner: "octocat/private-repo",
          cloneUrl: "https://github.com/octocat/private-repo.git",
          private: true,
          defaultBranch: "main",
        }),
      ],
      page: 1,
      hasNextPage: true,
    });
    expect(octokitMocks.paginate).toHaveBeenCalledWith(
      octokitMocks.listForAuthenticatedUser,
      expect.objectContaining({ per_page: 100, visibility: "all" }),
    );
    await client.listRepositories({ query: "second", page: 1, perPage: 10 });
    expect(octokitMocks.paginate).toHaveBeenCalledTimes(1);
  });

  it("gets a repository by owner/name and rejects ambiguous paths", async () => {
    octokitMocks.getRepository.mockResolvedValue({ data: repository });
    const client = makeGitHubApiClient({ token: "github_pat_test" });

    await expect(client.getRepository("octocat/private-repo.git")).resolves.toMatchObject({
      nameWithOwner: "octocat/private-repo",
    });
    expect(octokitMocks.getRepository).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "private-repo",
    });
    await expect(client.getRepository("invalid/path/extra")).rejects.toThrow("owner/repository");
  });
});

describe("redactGitHubSecrets", () => {
  it("redacts secret fields, known values, and GitHub token shapes", () => {
    expect(
      redactGitHubSecrets(
        {
          authorization: "Bearer known-token",
          nested: ["known-token", "ghp_abcdefghijklmnopqrstuvwxyz"],
          safe: "octocat",
        },
        ["known-token"],
      ),
    ).toEqual({
      authorization: "[REDACTED]",
      nested: ["[REDACTED]", "[REDACTED]"],
      safe: "octocat",
    });
  });
});
