import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useQueuedMessageStore, type QueuedComposerMessage } from "../queuedMessageStore";
import { sendQueuedMessage } from "./chat/sendQueuedMessage";
import { QueuedMessageSender } from "./QueuedMessageSender";

const io = vi.hoisted(() => ({
  run: vi.fn(),
  upload: vi.fn(),
  toast: vi.fn(),
  thread: null as unknown,
  shell: { runtimeMode: "full-access", interactionMode: "default" } as Record<string, unknown>,
}));
const config = {
  environment: { capabilities: { attachmentUploads: true, inlineMessageContext: true } },
  providers: [] as Array<Record<string, unknown>> | undefined,
};
/** A snapshot that accepts every attachment and access mode T3 can request. */
const permissiveProvider = (overrides: Record<string, unknown> = {}) => ({
  instanceId: ProviderInstanceId.make("codex"),
  displayName: "Codex",
  driver: "codex",
  supportsImageAttachments: true,
  supportsFileAttachments: true,
  ...overrides,
});
vi.mock("@t3tools/client-runtime/state/runtime", async (load) => ({
  ...(await load<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (...args: unknown[]) => io.run(...args),
}));
// `sendQueuedMessage` reads the config through the registry, so a test has to
// be able to swap what the registry hands back — including making the whole
// config absent, which is what a reconnect looks like to the gate.
const appAtomRegistryConfig = config;
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () =>
      new Map([
        [
          "env-a",
          appAtomRegistryConfig.providers === undefined
            ? undefined
            : { ...appAtomRegistryConfig, providers: appAtomRegistryConfig.providers },
        ],
      ]),
  },
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/threads", () => ({
  threadEnvironment: {
    updateMetadata: "metadata",
    setRuntimeMode: "runtime",
    setInteractionMode: "interaction",
    startTurn: "start",
  },
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));
vi.mock("../state/entities", () => ({
  useThread: () => io.thread,
  useThreadStatus: () => "live",
  useServerConfigs: () => new Map([["env-a", config]]),
  readThreadShell: () => io.shell,
  readThread: () => io.thread,
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: (...args: unknown[]) => io.toast(...args) } }));
vi.mock("../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: (...args: unknown[]) => io.upload(...args),
  getUploadedAttachments: () => [
    { type: "image", id: "uploaded", name: "a.png", mimeType: "image/png", sizeBytes: 4 },
  ],
  releaseDraftAttachments: vi.fn(),
}));

const threadRef = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const threadKey = scopedThreadKey(threadRef);
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

function enqueue(overrides: Partial<QueuedComposerMessage> = {}) {
  return useQueuedMessageStore.getState().enqueue(threadKey, {
    prompt: "follow up",
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    sendSettings: {
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      promptEffort: null,
    },
    queuedAfterToolActivityId: null,
    createdAt: "2026-09-25T00:00:00Z",
    ...overrides,
  });
}

const commandsRun = () => io.run.mock.calls.map((call) => call[1]);
const queue = () => useQueuedMessageStore.getState().queuesByThreadKey[threadKey];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
  io.thread = null;
  io.run.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  io.upload.mockReset().mockResolvedValue(undefined);
  io.toast.mockReset();
  // The capability gate is asserted in `sendQueuedMessage`, so every test
  // needs a provider snapshot it can resolve. Leaving this empty would make
  // each of them exercise the fail-closed "capability unknown" path instead of
  // what it is about.
  config.providers = [permissiveProvider()];
  io.shell = {
    modelSelection,
    branch: null,
    runtimeMode: "full-access",
    interactionMode: "default",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QueuedMessageSender", () => {
  const thread = (
    status: string,
    { toolActivityIds = [] as string[], userMessageIds = [] as string[] } = {},
  ) => ({
    session: { status, activeTurnId: null, updatedAt: status },
    activities: toolActivityIds.map((id, index) => ({
      id,
      kind: "tool.completed",
      sequence: index,
      createdAt: "2026-09-25T00:00:01Z",
    })),
    messages: userMessageIds.map((id) => ({ id, role: "user" })),
    latestTurn: null,
  });
  let root: ReactTestRenderer | null = null;
  const render = () =>
    act(() => {
      if (root) root.update(createElement(QueuedMessageSender));
      else root = create(createElement(QueuedMessageSender));
    });
  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
  });

  it("sends a queued message when the turn ends, with no chat view open", async () => {
    enqueue();
    io.thread = thread("running");
    await render();
    expect(commandsRun()).toEqual([]);

    io.thread = thread("ready");
    await render();

    expect(commandsRun()).toEqual(["start"]);
    expect(io.run.mock.calls[0]?.[2]).toMatchObject({
      environmentId: "env-a",
      input: { threadId: "thread-a", message: { text: "follow up" }, modelSelection },
    });
    expect(queue()).toBeUndefined();
  });

  it("holds the next message until the server picks up the one before it", async () => {
    enqueue({ prompt: "first" });
    enqueue({ prompt: "second" });
    io.thread = thread("ready");
    await render();
    await render();
    expect(commandsRun()).toEqual(["start"]);

    // The first message started a turn; the second waits for its next tool call.
    io.thread = thread("running", { userMessageIds: ["first"] });
    await render();
    expect(commandsRun()).toEqual(["start"]);
    io.thread = thread("running", { userMessageIds: ["first"], toolActivityIds: ["tool-1"] });
    await render();
    expect(commandsRun()).toEqual(["start", "start"]);
  });

  it("moves on to the next message after a failed one is cancelled", async () => {
    io.run.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
    const first = enqueue({ prompt: "first" });
    enqueue({ prompt: "second" });
    io.thread = thread("ready");
    await render();
    expect(queue()?.[0]).toMatchObject({ prompt: "first", holdUntilUserAction: true });

    await act(() => {
      useQueuedMessageStore.getState().remove(threadKey, first.id);
    });
    await render();

    expect(commandsRun()).toEqual(["start", "start"]);
    expect(io.run.mock.calls[1]?.[2]).toMatchObject({ input: { message: { text: "second" } } });
  });
});

describe("sendQueuedMessage", () => {
  it("saves a mode changed before queueing, then starts the turn", async () => {
    io.shell = { ...io.shell, runtimeMode: "approval-required" };
    const message = enqueue();

    await sendQueuedMessage(threadRef, message.id);

    expect(commandsRun()).toEqual(["runtime", "start"]);
    expect(io.run.mock.calls[1]?.[2]).toMatchObject({ input: { runtimeMode: "full-access" } });
    expect(queue()).toBeUndefined();
  });

  it("gives a message back to Stop while its upload runs, without starting a turn", async () => {
    let finishUpload!: () => void;
    io.upload.mockReturnValue(new Promise<void>((resolve) => (finishUpload = resolve)));
    const image = {
      type: "image" as const,
      id: "image-1",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 4,
      previewUrl: "data:image/png;base64,AAAA",
      file: new File(["AAAA"], "a.png", { type: "image/png" }),
    };
    const message = enqueue({ images: [image] });

    const sending = sendQueuedMessage(threadRef, message.id);
    expect(useQueuedMessageStore.getState().drain(threadKey)).toHaveLength(1);
    finishUpload();
    await sending;

    expect(commandsRun()).toEqual([]);
    expect(io.toast).not.toHaveBeenCalled();
    expect(queue()).toBeUndefined();
  });

  it("holds a message at the head when the turn start fails", async () => {
    io.run.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
    enqueue({ prompt: "first" });
    const second = enqueue({ prompt: "second" });

    await sendQueuedMessage(threadRef, second.id);

    expect(queue()?.map((entry) => [entry.prompt, entry.holdUntilUserAction])).toEqual([
      ["second", true],
      ["first", undefined],
    ]);
    expect(io.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "offline" }));
  });

  it("refuses to send attachments the selected provider cannot take", async () => {
    config.providers = [
      {
        instanceId: modelSelection.instanceId,
        displayName: "Antigravity",
        driver: "antigravity",
        supportsImageAttachments: false,
        supportsFileAttachments: false,
      },
    ];
    const image = {
      type: "image" as const,
      id: "image-1",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 4,
      previewUrl: "data:image/png;base64,AAAA",
      file: new File(["AAAA"], "a.png", { type: "image/png" }),
    };
    const message = enqueue({ images: [image] });

    await sendQueuedMessage(threadRef, message.id);

    expect(commandsRun()).toEqual([]);
    expect(io.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("Antigravity") }),
    );
    // Held for Send now rather than dropped: the draft can still be edited.
    expect(queue()?.map((entry) => [entry.prompt, entry.holdUntilUserAction])).toEqual([
      ["follow up", true],
    ]);
  });

  it("holds the message when the environment's capabilities are not loaded yet", async () => {
    // A reconnect leaves `serverConfig` undefined while the timeline is still
    // rendered. "Unknown" must not read as "supported": an image would be
    // inlined as a data URL and handed to a provider that drops it.
    const providers = config.providers;
    appAtomRegistryConfig.providers = undefined;
    try {
      const message = enqueue();
      await sendQueuedMessage(threadRef, message.id);

      expect(commandsRun()).toEqual([]);
      expect(io.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Waiting for the server",
          description: expect.stringContaining("Cancel this message"),
        }),
      );
      expect(queue()?.map((entry) => entry.holdUntilUserAction)).toEqual([true]);
    } finally {
      appAtomRegistryConfig.providers = providers;
    }
  });

  it("holds the message when its provider instance is no longer configured", async () => {
    // The instance id is frozen on the message, so a rename in Settings makes
    // the resolution fail rather than silently falling back to whatever
    // provider happens to be selected now.
    appAtomRegistryConfig.providers = [
      permissiveProvider({ instanceId: ProviderInstanceId.make("other") }),
    ];
    try {
      const message = enqueue();
      await sendQueuedMessage(threadRef, message.id);

      expect(commandsRun()).toEqual([]);
      expect(io.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
      expect(queue()?.map((entry) => entry.holdUntilUserAction)).toEqual([true]);
    } finally {
      appAtomRegistryConfig.providers = [permissiveProvider()];
    }
  });

  it("re-checks capabilities at send time, not only at enqueue time", async () => {
    // The provider can lose a capability between the message being queued and
    // the queue draining. Only a check that runs on the send path catches it.
    const message = enqueue({
      images: [
        {
          type: "image" as const,
          id: "image-1",
          name: "a.png",
          mimeType: "image/png",
          sizeBytes: 4,
          previewUrl: "data:image/png;base64,AAAA",
          file: new File(["AAAA"], "a.png", { type: "image/png" }),
        },
      ],
    });
    appAtomRegistryConfig.providers = [
      permissiveProvider({ supportsImageAttachments: false, supportsFileAttachments: false }),
    ];
    try {
      await sendQueuedMessage(threadRef, message.id);

      expect(commandsRun()).toEqual([]);
      expect(io.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Image attachments unavailable",
        }),
      );
    } finally {
      appAtomRegistryConfig.providers = [permissiveProvider()];
    }
  });

  it("sends attachments when the selected provider accepts them", async () => {
    config.providers = [permissiveProvider({ instanceId: modelSelection.instanceId })];
    const image = {
      type: "image" as const,
      id: "image-1",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 4,
      previewUrl: "data:image/png;base64,AAAA",
      file: new File(["AAAA"], "a.png", { type: "image/png" }),
    };
    const message = enqueue({ images: [image] });

    await sendQueuedMessage(threadRef, message.id);

    expect(commandsRun()).toEqual(["start"]);
    expect(io.toast).not.toHaveBeenCalled();
    expect(queue()).toBeUndefined();
  });
});
