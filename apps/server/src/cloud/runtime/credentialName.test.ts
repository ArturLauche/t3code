import { CloudRuntimeId, type CloudRuntimeConfig } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  cloudRuntimeCredentialName,
  sameCloudCredentialScope,
  staleCloudCredentialIds,
} from "./credentialName.ts";

const runtime = (overrides: Partial<CloudRuntimeConfig> = {}): CloudRuntimeConfig => ({
  kind: "e2b",
  enabled: true,
  setupCommands: [],
  ...overrides,
});

describe("cloudRuntimeCredentialName", () => {
  it("derives a stable, filesystem-safe key from the runtime id", () => {
    const id = CloudRuntimeId.make("team_e2b");
    const name = cloudRuntimeCredentialName(id);
    assert.match(name, /^[A-Za-z0-9_-]+$/u);
    assert.equal(name, cloudRuntimeCredentialName(id));
    assert.notEqual(
      name,
      cloudRuntimeCredentialName(CloudRuntimeId.make("other")),
      "each runtime id owns its own key",
    );
  });
});

describe("sameCloudCredentialScope", () => {
  it("treats every destination-defining field as part of the credential's scope", () => {
    const base = runtime();
    for (const change of [
      { kind: "daytona" as const },
      { domain: "other.example" },
      { apiUrl: "https://daytona.example" },
      { region: "eu-west-1" },
    ]) {
      assert.isFalse(
        sameCloudCredentialScope(base, runtime(change)),
        `${JSON.stringify(change)} moves the credential to a different destination`,
      );
    }
  });

  it("keeps the credential for edits that do not move it", () => {
    const base = runtime({ displayName: "Primary", setupCommands: ["npm install"] });
    assert.isTrue(
      sameCloudCredentialScope(
        base,
        runtime({ displayName: "Renamed", enabled: false, setupCommands: ["npm install", "make"] }),
      ),
    );
  });

  it("does not treat an absent endpoint as a configured one", () => {
    // The contract only ever produces a defined value or `undefined`; the
    // comparison is on the raw value so a hand-edited settings file cannot
    // quietly alias one runtime's endpoint onto another's.
    assert.isFalse(sameCloudCredentialScope(runtime(), runtime({ apiUrl: "https://x.example" })));
    assert.isTrue(sameCloudCredentialScope(runtime(), runtime()));
  });
});

describe("staleCloudCredentialIds", () => {
  const id = CloudRuntimeId.make("primary");

  it("reports nothing when the configuration is unchanged", () => {
    const map = { [id]: runtime({ setupCommands: ["npm install"] }) };
    assert.deepEqual(staleCloudCredentialIds(map, { [id]: runtime() }), []);
  });

  it("reports a removed runtime", () => {
    assert.deepEqual(staleCloudCredentialIds({ [id]: runtime() }, {}), [id]);
  });

  it("reports a runtime repointed at another vendor, endpoint or region", () => {
    for (const change of [
      { kind: "daytona" as const },
      { apiUrl: "https://daytona.example" },
      { region: "eu-west-1" },
      { domain: "other.example" },
    ]) {
      assert.deepEqual(staleCloudCredentialIds({ [id]: runtime() }, { [id]: runtime(change) }), [
        id,
      ]);
    }
  });

  it("leaves other runtimes alone when one is repointed", () => {
    const other = CloudRuntimeId.make("other");
    assert.deepEqual(
      staleCloudCredentialIds(
        { [id]: runtime(), [other]: runtime() },
        { [id]: runtime({ kind: "daytona" }), [other]: runtime() },
      ),
      [id],
    );
  });
});
