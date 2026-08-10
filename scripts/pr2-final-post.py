from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one post-patch match in {path}, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))


for path in ["packages/sandbox/src/adapters/e2b.ts", "packages/sandbox/src/adapters/novita.ts"]:
    replace_once(
        path,
        'import type {\n  CloudSandboxCreateInput,',
        'import * as Clock from "effect/Clock";\nimport * as DateTime from "effect/DateTime";\nimport * as Effect from "effect/Effect";\nimport type {\n  CloudSandboxCreateInput,',
    )
    replace_once(
        path,
        '''const lifecycle = {''',
        '''const currentEpochMillis = (): number => Effect.runSync(Clock.currentTimeMillis);
const currentIso = (): string => DateTime.formatIso(DateTime.makeUnsafe(currentEpochMillis()));

const lifecycle = {''',
    )
    replace_once(path, 'updatedAt: new Date().toISOString(),', 'updatedAt: currentIso(),')
    replace_once(
        path,
        'const remaining = info.endAt.getTime() - new Date().getTime();',
        'const remaining = info.endAt.getTime() - currentEpochMillis();',
    )

# The ephemeral-create ref belongs to the inner palette component that owns the state and callback,
# not the outer provider component that only owns the composer handle.
replace_once(
    "apps/web/src/components/CommandPalette.tsx",
    '''  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const ephemeralSandboxCreationRef = useRef(false);''',
    '''  const composerHandleRef = useRef<ChatComposerHandle | null>(null);''',
)
replace_once(
    "apps/web/src/components/CommandPalette.tsx",
    '''  const [isCreatingEphemeralSandbox, setIsCreatingEphemeralSandbox] = useState(false);''',
    '''  const [isCreatingEphemeralSandbox, setIsCreatingEphemeralSandbox] = useState(false);
  const ephemeralSandboxCreationRef = useRef(false);''',
)
