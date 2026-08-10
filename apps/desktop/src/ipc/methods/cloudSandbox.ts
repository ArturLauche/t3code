import {
  CloudSandboxAssociationInput,
  CloudSandboxCreateInput,
  CloudSandboxEnsureInput,
  CloudSandboxLifecycleInput,
  CloudSandboxProviderConnection,
  CloudSandboxProviderConnectionIdInput,
  CloudSandboxProviderConnectionInput,
  CloudSandboxRecord,
  DesktopCloudSandboxBootstrapSchema,
  DesktopCloudSandboxTargetSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopCloudSandboxEnvironment from "../../sandbox/DesktopCloudSandboxEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const listCloudSandboxProviderConnections = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_CLOUD_SANDBOX_PROVIDER_CONNECTIONS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(CloudSandboxProviderConnection),
  handler: Effect.fn("desktop.ipc.cloudSandbox.listProviders")(function* () {
    const cloud = yield* DesktopCloudSandboxEnvironment.DesktopCloudSandboxEnvironment;
    return yield* cloud.listProviderConnections;
  }),
});

export const saveCloudSandboxProviderConnection = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SAVE_CLOUD_SANDBOX_PROVIDER_CONNECTION_CHANNEL,
  payload: CloudSandboxProviderConnectionInput,
  result: CloudSandboxProviderConnection,
  handler: Effect.fn("desktop.ipc.cloudSandbox.saveProvider")(function* (input) {
    const cloud = yield* DesktopCloudSandboxEnvironment.DesktopCloudSandboxEnvironment;
    return yield* cloud.saveProviderConnection(input);
  }),
});

export const validateCloudSandboxProviderConnection = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VALIDATE_CLOUD_SANDBOX_PROVIDER_CONNECTION_CHANNEL,
  payload: CloudSandboxProviderConnectionIdInput,
  result: CloudSandboxProviderConnection,
  handler: Effect.fn("desktop.ipc.cloudSandbox.validateProvider")(function* ({ id }) {
    const cloud = yield* DesktopCloudSandboxEnvironment.DesktopCloudSandboxEnvironment;
    return yield* cloud.validateProviderConnection(id);
  }),
});

export const removeCloudSandboxProviderConnection = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOVE_CLOUD_SANDBOX_PROVIDER_CONNECTION_CHANNEL,
  payload: CloudSandboxProviderConnectionIdInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.cloudSandbox.removeProvider")(function* ({ id }) {
    const cloud = yield* DesktopCloudSandboxEnvironment.DesktopCloudSandboxEnvironment;
    yield* cloud.removeProviderConnection(id);
  }),
});

export const listCloudSandboxes = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_CLOUD_SANDBOXES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(CloudSandboxRecord),
  handler: Effect.fn("desktop.ipc.cloudSandbox.list")(function* () {
    const cloud = yield* DesktopCloudSandboxEnvironment.DesktopCloudSandboxEnvironment;
    return yield* cloud.listSandboxes;
  }),
});

export const createCloudSandbox = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CREATE_CLOUD_SANDBOX_CHANNEL,
  payload: CloudSandboxCreateInput,
  result: CloudSandboxRecord,
  handler: Effect.fn("desktop.ipc.cloudSandbox.create")(function* (input) {
    const cloud = yield* DesktopCloudSandboxEnvironment.DesktopCloudSandboxEnvironment;
    return yield* cloud.createSandbox(input);
  }),
});

export const ensureCloudSandbox = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENSURE_CLOUD_SANDBOX_CHANNEL,
  payload: CloudSandboxEnsureInput,
  result: DesktopCloudSandboxBootstrapSchema,
  handler: Effect.fn("desktop.ipc.cloudSandbox.ensure")(function* (input) {
    const cloud = yield* DesktopCloudSandboxEnvironment.DesktopCloudSandboxEnvironment;
    return yield* cloud.ensureSandbox(input);
  }),
});

export const disconnectCloudSandbox = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCONNECT_CLOUD_SANDBOX_CHANNEL,
  payload: DesktopCloudSandboxTargetSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.cloudSandbox.disconnect")(function* (target) {
    const cloud = yield* DesktopCloudSandboxEnvironment.DesktopCloudSandboxEnvironment;
    yield* cloud.disconnectSandbox(target);
  }),
});

export const runCloudSandboxLifecycleAction = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOUD_SANDBOX_LIFECYCLE_CHANNEL,
  payload: CloudSandboxLifecycleInput,
  result: Schema.NullOr(CloudSandboxRecord),
  handler: Effect.fn("desktop.ipc.cloudSandbox.lifecycle")(function* (input) {
    const cloud = yield* DesktopCloudSandboxEnvironment.DesktopCloudSandboxEnvironment;
    return yield* cloud.lifecycle(input);
  }),
});

export const associateCloudSandboxProject = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ASSOCIATE_CLOUD_SANDBOX_PROJECT_CHANNEL,
  payload: CloudSandboxAssociationInput,
  result: CloudSandboxRecord,
  handler: Effect.fn("desktop.ipc.cloudSandbox.associate")(function* (input) {
    const cloud = yield* DesktopCloudSandboxEnvironment.DesktopCloudSandboxEnvironment;
    return yield* cloud.associateProject(input);
  }),
});
