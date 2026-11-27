import { describe, expect, it } from "vite-plus/test";

import { TerminalDriver } from "./TerminalDriver.ts";

describe("TerminalDriver", () => {
  it("is a local, single-instance driver with a default instance", () => {
    expect(TerminalDriver.metadata).toMatchObject({
      displayName: "Terminal",
      supportsCloudExecution: false,
      supportsMultipleInstances: false,
      hasDefaultInstance: true,
    });
    expect(TerminalDriver.driverKind).toBe("terminal");
  });
});
