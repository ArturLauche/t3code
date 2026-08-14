import type { CloudSandboxProviderConnection, GitHubRepositorySummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  executionEnvironmentPickerCategory,
  githubRepositoryCloneSelection,
  quickEphemeralSandboxInput,
} from "./projectCreation.logic";

describe("Add Project execution environment choices", () => {
  it.each([
    ["PrimaryConnectionTarget", false, "Local"],
    ["BearerConnectionTarget", true, "Local"],
    ["BearerConnectionTarget", false, "Remote"],
    ["RelayConnectionTarget", false, "Remote"],
    ["SshConnectionTarget", false, "SSH Remote"],
    ["CloudSandboxConnectionTarget", false, "Cloud Sandbox"],
  ] as const)("labels %s as %s execution", (targetTag, desktopLocal, expected) => {
    expect(executionEnvironmentPickerCategory({ targetTag, desktopLocal })).toBe(expected);
  });

  it("selects a GitHub repository with a clean HTTPS clone URL", () => {
    const selected = githubRepositoryCloneSelection({
      nameWithOwner: "octocat/private-repo",
      url: "https://github.com/octocat/private-repo",
      cloneUrl: "https://github.com/octocat/private-repo.git",
      sshUrl: "git@github.com:octocat/private-repo.git",
    } as GitHubRepositorySummary);

    expect(selected).toEqual({
      repository: {
        provider: "github",
        nameWithOwner: "octocat/private-repo",
        url: "https://github.com/octocat/private-repo",
        sshUrl: "git@github.com:octocat/private-repo.git",
      },
      remoteUrl: "https://github.com/octocat/private-repo.git",
    });
    expect(selected.remoteUrl).not.toContain("@");
    expect(selected.remoteUrl).not.toContain("token");
  });

  it.each(["daytona", "e2b", "novita"] as const)(
    "creates a provider-valid ephemeral %s task sandbox choice",
    (provider) => {
      const connection = {
        id: `${provider}:connection` as never,
        provider,
        label: provider,
        apiUrl: null,
        credentialConfigured: true,
        createdAt: "2026-01-01T00:00:00Z",
        lastValidatedAt: "2026-01-01T00:00:00Z",
      } satisfies CloudSandboxProviderConnection;
      const input = quickEphemeralSandboxInput(connection, "t3-task");

      expect(input).toMatchObject({
        providerConnectionId: connection.id,
        provider,
        ephemeral: true,
        name: "t3-task",
      });
      if (provider === "daytona") {
        expect(input).toMatchObject({ ttlMinutes: 60 });
      } else {
        expect(input).toMatchObject({
          timeoutMinutes: 60,
          timeoutAction: "delete",
          autoResume: false,
        });
      }
    },
  );
});
