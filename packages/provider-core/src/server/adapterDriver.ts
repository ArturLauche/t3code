import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { CloudExecutionTransport } from "./cloudExecution.ts";
import type { ProviderDriverCreateInput } from "./driver.ts";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export class ProviderAdapterDriverCreateError extends Schema.TaggedError<ProviderAdapterDriverCreateError>()(
  "ProviderAdapterDriverCreateError",
  {
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to create orchestration-v2 provider adapter ${this.instanceId} (${this.driver}): ${this.detail}`;
  }
}

export interface ProviderAdapterDriverCreateInput<
  Config,
> extends ProviderDriverCreateInput<Config> {
  /**
   * Present when the instance targets a cloud sandbox. The provider driver
   * owns building it — only the driver knows the runtime's credentials — and
   * hands the adapter the spawner plus the local-to-remote cwd mapping.
   */
  readonly cloudTransport?: CloudExecutionTransport;
}

export interface ProviderAdapterDriver<Config, R = never> {
  readonly driverKind: ProviderDriverKind;
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  readonly create: (
    input: ProviderAdapterDriverCreateInput<Config>,
  ) => Effect.Effect<
    ProviderAdapter.ProviderAdapterV2["Service"],
    ProviderAdapterDriverCreateError,
    R | Scope.Scope
  >;
}

export type AnyProviderAdapterDriver<R = never> = ProviderAdapterDriver<any, R>;
