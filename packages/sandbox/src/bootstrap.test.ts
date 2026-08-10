import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSandboxLaunchCommand,
  buildSandboxPairingCommand,
  parseSandboxPairingCredential,
} from "./bootstrap.ts";

function decodedScript(command: string): string {
  const encoded = command.match(/printf '%s' '([^']+)'/)?.[1];
  if (!encoded) throw new Error("No encoded shell script was found.");
  return NodeBuffer.Buffer.from(encoded, "base64").toString("utf8");
}

describe("sandbox T3 bootstrap", () => {
  it("embeds the runner safely and binds the server for provider port exposure", () => {
    const command = buildSandboxLaunchCommand("#!/bin/sh\necho runner", 4555);
    const script = decodedScript(command);

    expect(script).toContain("T3CODE_NO_BROWSER=1");
    expect(script).toContain("--host 0.0.0.0");
    expect(script).toContain("#!/bin/sh\necho runner");
    expect(command).toContain("4555");
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
