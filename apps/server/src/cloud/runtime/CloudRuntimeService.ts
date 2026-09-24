import type {
  CloudRuntimeCredentialInput,
  CloudRuntimeExecuteInput,
  CloudRuntimeExecuteResult,
  CloudRuntimeId,
  CloudRuntimeListResult,
  CloudRuntimeSandboxActionInput,
  CloudRuntimeSandboxCreateInput,
  CloudRuntimeSandboxListInput,
  CloudRuntimeSandboxListResult,
  CloudRuntimeTestInput,
  CloudExecutionHandle,
} from "@t3tools/contracts";
import { CloudRuntimeError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { CloudProcess } from "./CloudProcess.ts";
import type { CloudCommandSpec, CloudVendorAdapter } from "./VendorAdapter.ts";

export interface CloudExecutionPrepareInput {
  readonly runtimeId: CloudRuntimeId;
  readonly name: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Optional workspace archive uploaded before setup commands run. */
  readonly workspaceArchive?: Uint8Array;
}

export interface CloudRuntimeServiceShape {
  readonly list: () => Effect.Effect<
    CloudRuntimeListResult,
    import("@t3tools/contracts").CloudRuntimeError
  >;
  readonly setCredential: (
    input: CloudRuntimeCredentialInput,
  ) => Effect.Effect<CloudRuntimeListResult, import("@t3tools/contracts").CloudRuntimeError>;
  readonly clearCredential: (
    runtimeId: CloudRuntimeId,
  ) => Effect.Effect<CloudRuntimeListResult, import("@t3tools/contracts").CloudRuntimeError>;
  readonly test: (
    input: CloudRuntimeTestInput,
  ) => Effect.Effect<CloudRuntimeListResult, import("@t3tools/contracts").CloudRuntimeError>;
  readonly createSandbox: (
    input: CloudRuntimeSandboxCreateInput,
  ) => Effect.Effect<CloudRuntimeSandboxListResult, import("@t3tools/contracts").CloudRuntimeError>;
  readonly listSandboxes: (
    input: CloudRuntimeSandboxListInput,
  ) => Effect.Effect<CloudRuntimeSandboxListResult, import("@t3tools/contracts").CloudRuntimeError>;
  readonly sandboxAction: (
    input: CloudRuntimeSandboxActionInput,
  ) => Effect.Effect<CloudRuntimeSandboxListResult, import("@t3tools/contracts").CloudRuntimeError>;
  readonly execute: (
    input: CloudRuntimeExecuteInput,
  ) => Effect.Effect<CloudRuntimeExecuteResult, import("@t3tools/contracts").CloudRuntimeError>;
  readonly withVendor: <A, E, R>(
    runtimeId: CloudRuntimeId,
    use: (
      vendor: CloudVendorAdapter,
      context: { readonly apiKey: string },
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | import("@t3tools/contracts").CloudRuntimeError, R>;
  readonly startProcess: (
    runtimeId: CloudRuntimeId,
    sandboxId: string,
    command: CloudCommandSpec,
  ) => Effect.Effect<CloudProcess, import("@t3tools/contracts").CloudRuntimeError>;
  /** Prepare a reusable sandbox and run the runtime's setup commands once per preparation. */
  readonly prepareExecution: (
    input: CloudExecutionPrepareInput,
  ) => Effect.Effect<CloudExecutionHandle, import("@t3tools/contracts").CloudRuntimeError>;
}

const unavailableError = (operation: string): CloudRuntimeError =>
  new CloudRuntimeError({
    operation,
    reason: "unsupported",
    message: "Cloud runtime support is not available in this server runtime.",
  });

const unavailableCloudRuntimeService: CloudRuntimeServiceShape = {
  list: () => Effect.succeed({ runtimes: [] }),
  setCredential: () => Effect.fail(unavailableError("set-credential")),
  clearCredential: () => Effect.fail(unavailableError("clear-credential")),
  test: () => Effect.fail(unavailableError("test")),
  createSandbox: () => Effect.fail(unavailableError("create-sandbox")),
  listSandboxes: () => Effect.fail(unavailableError("list-sandboxes")),
  sandboxAction: () => Effect.fail(unavailableError("sandbox-action")),
  execute: () => Effect.fail(unavailableError("execute")),
  withVendor: () => Effect.fail(unavailableError("cloud-runtime")),
  startProcess: () => Effect.fail(unavailableError("start-process")),
  prepareExecution: () => Effect.fail(unavailableError("prepare-execution")),
};

export class CloudRuntimeService extends Context.Reference<CloudRuntimeServiceShape>(
  "t3/cloud/runtime/CloudRuntimeService",
  { defaultValue: () => unavailableCloudRuntimeService },
) {}
