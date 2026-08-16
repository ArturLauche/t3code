/**
 * Ambient declarations for sandbox provider SDKs that are loaded lazily and are
 * optional peer dependencies. They are intentionally minimal: the adapters
 * (DaytonaAdapter, E2bAdapter, NovitaAdapter) access the SDK through narrow
 * structural interfaces, so a full type bundle is not required to typecheck.
 *
 * Install the real package to use a provider at runtime:
 *   pnpm add -F t3 @daytonaio/sdk
 *   pnpm add -F t3 e2b
 *   pnpm add -F t3 novita-sandbox
 */

declare module "@daytonaio/sdk" {
  export interface DaytonaSandbox {
    id: string;
    getInfo?(): Promise<{ state?: string; name?: string; region?: string }>;
    createSshAccess?(
      expiresInMinutes?: number,
    ): Promise<{ token?: string; host?: string; port?: number; login?: string }>;
    start?(): Promise<void>;
    stop?(): Promise<void>;
    delete?(timeout?: number, wait?: boolean): Promise<void>;
  }
  export interface DaytonaCreateInput {
    name?: string;
    template?: string;
    region?: string;
    autoStopInterval?: number;
  }
  export class Daytona {
    constructor(options?: { apiKey?: string; apiUrl?: string });
    create?(input?: DaytonaCreateInput): Promise<DaytonaSandbox>;
    get?(id: string): Promise<DaytonaSandbox>;
  }
}

declare module "e2b" {
  export interface E2BSandbox {
    sandboxId: string;
    getInfo?(): Promise<{ state?: string }>;
    pause?(opts?: unknown): Promise<void>;
    kill?(opts?: unknown): Promise<void>;
    commands?: { run: (command: string, opts?: unknown) => Promise<{ stdout?: string }> };
  }
  export class Sandbox {
    static create(input?: unknown): Promise<E2BSandbox>;
    static connect(sandboxId: string, opts?: unknown): Promise<E2BSandbox>;
    static kill(sandboxId: string, opts?: unknown): Promise<void>;
  }
}

declare module "novita-sandbox/code-interpreter" {
  export interface NovitaSandbox {
    sandboxId: string;
    getInfo?(): Promise<{ state?: string }>;
    pause?(opts?: unknown): Promise<void>;
    kill?(opts?: unknown): Promise<void>;
    commands?: { run: (command: string, opts?: unknown) => Promise<{ stdout?: string }> };
  }
  export class Sandbox {
    static create(input?: unknown): Promise<NovitaSandbox>;
    static connect(sandboxId: string, opts?: unknown): Promise<NovitaSandbox>;
    static kill(sandboxId: string, opts?: unknown): Promise<void>;
  }
}
