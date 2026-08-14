import { Octokit } from "@octokit/rest";
import type {
  GitHubAccount,
  GitHubRepositoryListInput,
  GitHubRepositoryListResult,
  GitHubRepositorySummary,
} from "@t3tools/contracts";

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 100;

export interface GitHubApiClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
}

export interface GitHubApiClient {
  readonly getAccount: () => Promise<GitHubAccount>;
  readonly listRepositories: (
    input?: GitHubRepositoryListInput,
  ) => Promise<GitHubRepositoryListResult>;
  readonly getRepository: (nameWithOwner: string) => Promise<GitHubRepositorySummary>;
}

function splitRepository(nameWithOwner: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = nameWithOwner
    .trim()
    .replace(/\.git$/u, "")
    .split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error("GitHub repositories must use the owner/repository form.");
  }
  return { owner, repo };
}

function repositorySummary(repository: {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly description: string | null;
  readonly html_url: string;
  readonly clone_url: string | null;
  readonly ssh_url: string | null;
  readonly default_branch: string | null;
  readonly private: boolean;
  readonly archived: boolean;
  readonly pushed_at?: string | null;
}): GitHubRepositorySummary {
  return {
    id: repository.id,
    name: repository.name,
    nameWithOwner: repository.full_name,
    description: repository.description,
    url: repository.html_url,
    cloneUrl: repository.clone_url ?? `${repository.html_url}.git`,
    sshUrl: repository.ssh_url ?? `git@github.com:${repository.full_name}.git`,
    defaultBranch: repository.default_branch ?? "main",
    private: repository.private,
    archived: repository.archived,
    pushedAt: repository.pushed_at ?? null,
  };
}

export function makeGitHubApiClient(options: GitHubApiClientOptions): GitHubApiClient {
  const octokit = new Octokit({
    auth: options.token,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    userAgent: "t3-code",
  });
  let accessibleRepositories: Promise<readonly GitHubRepositorySummary[]> | null = null;

  const loadAccessibleRepositories = () => {
    accessibleRepositories ??= octokit
      .paginate(octokit.rest.repos.listForAuthenticatedUser, {
        affiliation: "owner,collaborator,organization_member",
        visibility: "all",
        sort: "pushed",
        direction: "desc",
        per_page: MAX_PER_PAGE,
      })
      .then((repositories) => repositories.map(repositorySummary));
    return accessibleRepositories;
  };

  return {
    getAccount: async () => {
      const { data } = await octokit.rest.users.getAuthenticated();
      return {
        login: data.login,
        name: data.name,
        avatarUrl: data.avatar_url,
        profileUrl: data.html_url,
      };
    },
    listRepositories: async (input = {}) => {
      const page = input.page ?? 1;
      const perPage = Math.min(MAX_PER_PAGE, input.perPage ?? DEFAULT_PER_PAGE);
      const query = input.query?.trim().toLocaleLowerCase() ?? "";
      const matching = (await loadAccessibleRepositories()).filter((repository) =>
        query.length === 0
          ? true
          : repository.nameWithOwner.toLocaleLowerCase().includes(query) ||
            (repository.description?.toLocaleLowerCase().includes(query) ?? false),
      );
      const offset = (page - 1) * perPage;
      return {
        repositories: matching.slice(offset, offset + perPage),
        page,
        hasNextPage: offset + perPage < matching.length,
      };
    },
    getRepository: async (nameWithOwner) => {
      const { owner, repo } = splitRepository(nameWithOwner);
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return repositorySummary(data);
    },
  };
}
