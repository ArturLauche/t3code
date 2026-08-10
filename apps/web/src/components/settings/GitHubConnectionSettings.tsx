import type { GitHubConnectionStatus, GitHubDeviceAuthorization } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { GitHubIcon } from "../Icons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub connection failed.";
}

function PersonalAccessTokenDialog({ onConnected }: { readonly onConnected: () => Promise<void> }) {
  const bridge = window.desktopBridge;
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    if (!bridge || !token.trim()) return;
    setPending(true);
    setError(null);
    try {
      await bridge.connectGitHubPersonalAccessToken({ token: token.trim() });
      setToken("");
      setOpen(false);
      await onConnected();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="xs" variant="outline">
            Use personal access token
          </Button>
        }
      />
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect with a personal access token</DialogTitle>
          <DialogDescription>
            Advanced mode. Prefer a fine-grained token limited to the repositories you use. The
            token is encrypted by the desktop OS secure store.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="github_pat_••••••••"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          <Button disabled={pending || !token.trim()} onClick={() => void connect()}>
            {pending ? (
              <>
                <Spinner className="size-3.5" /> Validating…
              </>
            ) : (
              "Connect"
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function GitHubConnectionSettingsSection() {
  const bridge = window.desktopBridge;
  const [status, setStatus] = useState<GitHubConnectionStatus | null>(null);
  const [authorization, setAuthorization] = useState<GitHubDeviceAuthorization | null>(null);
  const [pending, setPending] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    setStatus(await bridge.getGitHubConnectionStatus());
  }, [bridge]);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [refresh]);

  const poll = useCallback(async () => {
    if (!bridge || !authorization) return;
    try {
      const next = await bridge.pollGitHubDeviceAuthorization();
      setStatus(next);
      if (next.state === "authorizing") {
        pollTimer.current = setTimeout(
          () => void poll(),
          Math.max(authorization.intervalSeconds, 2) * 1_000,
        );
      } else {
        setAuthorization(null);
        setPending(false);
      }
    } catch (cause) {
      setPending(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not connect GitHub",
          description: message(cause),
        }),
      );
    }
  }, [authorization, bridge]);

  useEffect(() => {
    if (authorization && pending) {
      pollTimer.current = setTimeout(() => void poll(), authorization.intervalSeconds * 1_000);
    }
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [authorization, pending, poll]);

  if (!bridge) return null;

  const startDevice = async () => {
    setPending(true);
    try {
      const next = await bridge.startGitHubDeviceAuthorization();
      setAuthorization(next);
      setStatus({
        state: "authorizing",
        mode: "device",
        account: null,
        expiresAt: null,
        detail: "Waiting for GitHub authorization.",
        deviceFlowConfigured: true,
      });
      await bridge.openExternal(next.verificationUri);
    } catch (cause) {
      setPending(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start GitHub authorization",
          description: message(cause),
        }),
      );
    }
  };

  const disconnect = async () => {
    await bridge.disconnectGitHub();
    setAuthorization(null);
    await refresh();
  };

  return (
    <SettingsSection title="GitHub">
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-2">
            <GitHubIcon className="size-4" /> GitHub account
          </span>
        }
        description={
          status?.state === "connected" && status.account
            ? `Connected as ${status.account.login} using ${status.mode === "personal-access-token" ? "a personal access token" : "GitHub authorization"}. This connection is available to Local, SSH, and Cloud Sandbox environments.`
            : "Connect once to browse repositories and use private clone, fetch, pull, and push across every execution environment. Existing gh CLI authentication remains a fallback."
        }
        control={
          status?.state === "connected" ? (
            <div className="flex items-center gap-2">
              {status.account?.avatarUrl ? (
                <img alt="" className="size-6 rounded-full" src={status.account.avatarUrl} />
              ) : null}
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void bridge.openExternal(status.account?.profileUrl ?? "https://github.com")
                }
              >
                Open GitHub <ExternalLinkIcon />
              </Button>
              <Button size="xs" variant="ghost" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              {status?.deviceFlowConfigured ? (
                <Button size="xs" disabled={pending} onClick={() => void startDevice()}>
                  {pending ? (
                    <>
                      <Spinner className="size-3.5" /> Waiting…
                    </>
                  ) : (
                    "Connect GitHub"
                  )}
                </Button>
              ) : null}
              <PersonalAccessTokenDialog onConnected={refresh} />
            </div>
          )
        }
      />
      {authorization ? (
        <SettingsRow
          title="Authorize this device"
          description={`Open ${authorization.verificationUri} and enter the one-time code. It expires at ${new Date(authorization.expiresAt).toLocaleTimeString()}.`}
          control={
            <code className="select-all rounded bg-muted px-3 py-1.5 text-sm font-semibold tracking-widest">
              {authorization.userCode}
            </code>
          }
        />
      ) : null}
      {status?.state === "error" && status.detail ? (
        <p className="px-4 pb-3 text-xs text-destructive">{status.detail}</p>
      ) : null}
    </SettingsSection>
  );
}
