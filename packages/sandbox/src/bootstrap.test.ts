import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSandboxLaunchCommand,
  buildSandboxPairingCommand,
  buildSandboxStopCommand,
  parseSandboxPairingCredential,
} from "./bootstrap.ts";

function decodedScript(command: string): string {
  const encoded = command.match(/printf '%s' '([^']+)'/)?.[1];
  if (!encoded) throw new Error("No encoded shell script was found.");
  return NodeBuffer.Buffer.from(encoded, "base64").toString("utf8");
}

describe("sandbox T3 bootstrap", () => {
  it("embeds the runner safely and waits for an old process before relaunch", () => {
    const command = buildSandboxLaunchCommand("#!/bin/sh\necho runner", 4555);
    const script = decodedScript(command);

    expect(script).toContain("T3CODE_NO_BROWSER=1");
    expect(script).toContain("--host 0.0.0.0");
    expect(script).toContain("#!/bin/sh\necho runner");
    expect(script).toContain('wait_for_exit "$PID"');
    expect(script).toContain("Timed out waiting for T3 server process");
    expect(command).toContain("4555");
  });

  it("waits for the server process before removing its pid file", () => {
    const script = decodedScript(buildSandboxStopCommand());
    expect(script.indexOf('while kill -0 "$PID"')).toBeLessThan(
      script.indexOf('rm -f "$PID_FILE"'),
    );
    expect(script).toContain("Timed out waiting for T3 server process");
  });

  it("parses the final pairing credential without leaking progress output", () => {
    expect(
      parseSandboxPairingCredential(
        'installing\n{"progress":50}\n{"credential":"pairing-secret"}\n',
      ),
    ).toBe("pairing-secret");
    expect(() => parseSandboxPairingCredential("no credential")).toThrow(
      "did not return a pairing credential",
    );
    expect(decodedScript(buildSandboxPairingCommand())).toContain("auth pairing create");
  });
});
