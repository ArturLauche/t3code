import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as GitHubConnection from "./GitHubConnection.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeLayer(handler: (req: HttpClientRequest.HttpClientRequest) => Response) {
  const execute = vi.fn((req: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(req, handler(req))),
  );
  const httpLayer = Layer.succeed(HttpClient.HttpClient, HttpClient.make((req) => execute(req)));
  return GitHubConnection.githubClientLayer.pipe(Layer.provide(httpLayer));
}

describe("GitHubConnection.validateCredential", () => {
  it.effect("returns ok with the account login for a valid credential", () =>
    Effect.gen(function* () {
      const client = yield* GitHubConnection.GitHubClient;
      const result = yield* client.validateCredential("github.com", "ghp_validtoken123");
      expect(result.ok).toBe(true);
      expect(result.account).toBe("octocat");
    }).pipe(Effect.provide(makeLayer(() => jsonResponse({ login: "octocat", name: "The Octocat" })))));

  it.effect("returns not ok for a rejected credential (401)", () =>
    Effect.gen(function* () {
      const client = yield* GitHubConnection.GitHubClient;
      const matched = yield* client
        .validateCredential("github.com", "ghp_badtoken")
        .pipe(Effect.match({ onFailure: () => "failed" as const, onSuccess: (r) => (r.ok ? "ok" : "rejected" as const) }));
      expect(matched).toBe("rejected");
    }).pipe(Effect.provide(makeLayer(() => errorResponse(401, "Bad credentials")))));
});

describe("GitHubConnection.listRepositories", () => {
  it.effect("returns repositories visible to the credential", () =>
    Effect.gen(function* () {
      const client = yield* GitHubConnection.GitHubClient;
      const result = yield* client.listRepositories({
        host: "github.com",
        credential: "ghp_validtoken123",
      });
      expect(result.repositories.length).toBeGreaterThan(0);
      const first = result.repositories[0];
      expect(first?.nameWithOwner).toBe("octocat/hello-world");
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          jsonResponse([
            {
              full_name: "octocat/hello-world",
              name: "hello-world",
              owner: { login: "octocat" },
              html_url: "https://github.com/octocat/hello-world",
              ssh_url: "git@github.com:octocat/hello-world.git",
              private: false,
              default_branch: "main",
            },
          ]),
        ),
      ),
    ));

  it.effect("masks tokens in error messages", () =>
    Effect.gen(function* () {
      const client = yield* GitHubConnection.GitHubClient;
      const matched = yield* client
        .listRepositories({ host: "github.com", credential: "ghp_secrettoken123" })
        .pipe(
          Effect.match({
            onFailure: (err) => err.message,
            onSuccess: () => "succeeded" as const,
          }),
        );
      // The raw token must never appear in the surfaced message.
      expect(String(matched)).not.toContain("ghp_secrettoken123");
    }).pipe(Effect.provide(makeLayer(() => errorResponse(500, "ghp_secrettoken123 leaked")))));
});

describe("GitHubConnection.requestDeviceCode", () => {
  it.effect("surfaces the device code, user code, and verification uri", () =>
    Effect.gen(function* () {
      const client = yield* GitHubConnection.GitHubClient;
      const auth = yield* client.requestDeviceCode;
      expect(auth.deviceCode).toBe("dc_test123");
      expect(auth.userCode).toBe("ABCD-1234");
      expect(auth.verificationUri).toBe("https://github.com/login/device");
      expect(auth.intervalSeconds).toBe(5);
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          jsonResponse({
            device_code: "dc_test123",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
        ),
      ),
    ));
});
