import {
  DesktopGitHubCredentialSyncInputSchema,
  GitHubConnectionStatus,
  GitHubDeviceAuthorization,
  GitHubPersonalAccessTokenInput,
  GitHubRepositoryListInput,
  GitHubRepositoryListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopGitHubIntegration from "../../github/DesktopGitHubIntegration.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getGitHubConnectionStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_GITHUB_CONNECTION_STATUS_CHANNEL,
  payload: Schema.Void,
  result: GitHubConnectionStatus,
  handler: Effect.fn("desktop.ipc.github.status")(function* () {
    return yield* (yield* DesktopGitHubIntegration.DesktopGitHubIntegration).status;
  }),
});

export const connectGitHubPersonalAccessToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONNECT_GITHUB_PAT_CHANNEL,
  payload: GitHubPersonalAccessTokenInput,
  result: GitHubConnectionStatus,
  handler: Effect.fn("desktop.ipc.github.connectPat")(function* (input) {
    return yield* (yield* DesktopGitHubIntegration.DesktopGitHubIntegration).connectPersonalAccessToken(
      input,
    );
  }),
});

export const startGitHubDeviceAuthorization = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.START_GITHUB_DEVICE_AUTHORIZATION_CHANNEL,
  payload: Schema.Void,
  result: GitHubDeviceAuthorization,
  handler: Effect.fn("desktop.ipc.github.startDevice")(function* () {
    return yield* (yield* DesktopGitHubIntegration.DesktopGitHubIntegration)
      .startDeviceAuthorization;
  }),
});

export const pollGitHubDeviceAuthorization = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.POLL_GITHUB_DEVICE_AUTHORIZATION_CHANNEL,
  payload: Schema.Void,
  result: GitHubConnectionStatus,
  handler: Effect.fn("desktop.ipc.github.pollDevice")(function* () {
    return yield* (yield* DesktopGitHubIntegration.DesktopGitHubIntegration)
      .pollDeviceAuthorization;
  }),
});

export const disconnectGitHub = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCONNECT_GITHUB_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.github.disconnect")(function* () {
    yield* (yield* DesktopGitHubIntegration.DesktopGitHubIntegration).disconnect;
  }),
});

export const listGitHubRepositories = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_GITHUB_REPOSITORIES_CHANNEL,
  payload: GitHubRepositoryListInput,
  result: GitHubRepositoryListResult,
  handler: Effect.fn("desktop.ipc.github.listRepositories")(function* (input) {
    return yield* (yield* DesktopGitHubIntegration.DesktopGitHubIntegration).listRepositories(
      input,
    );
  }),
});

export const syncGitHubCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SYNC_GITHUB_CREDENTIAL_CHANNEL,
  payload: DesktopGitHubCredentialSyncInputSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.github.syncCredential")(function* (input) {
    return yield* (yield* DesktopGitHubIntegration.DesktopGitHubIntegration).syncCredential(input);
  }),
});
