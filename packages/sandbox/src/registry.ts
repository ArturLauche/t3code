import type { CloudSandboxProviderKind } from "@t3tools/contracts";

import { makeDaytonaSandboxProvider } from "./adapters/daytona.ts";
import { makeE2bSandboxProvider } from "./adapters/e2b.ts";
import { makeNovitaSandboxProvider } from "./adapters/novita.ts";
import type { SandboxProviderAdapter, SandboxProviderCredential } from "./provider.ts";

export function makeSandboxProvider(input: {
  readonly kind: CloudSandboxProviderKind;
  readonly connectionId: string;
  readonly credential: SandboxProviderCredential;
}): SandboxProviderAdapter {
  switch (input.kind) {
    case "daytona":
      return makeDaytonaSandboxProvider(input);
    case "e2b":
      return makeE2bSandboxProvider(input);
    case "novita":
      return makeNovitaSandboxProvider(input);
  }
}

export class SandboxProviderRegistry {
  private readonly adapters: ReadonlyMap<CloudSandboxProviderKind, SandboxProviderAdapter>;

  constructor(adapters: readonly SandboxProviderAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  get(kind: CloudSandboxProviderKind): SandboxProviderAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new Error(`No ${kind} sandbox provider adapter is registered.`);
    }
    return adapter;
  }
}
