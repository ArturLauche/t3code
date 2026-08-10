from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one type-fix match in {path}, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "packages/github/src/deviceFlow.ts",
    '''    let resolveVerification: ((verification: Verification) => void) | null = null;
    let rejectVerification: ((error: unknown) => void) | null = null;
    let verificationReceived = false;
    const verification = new Promise<Verification>((resolve, reject) => {
      resolveVerification = resolve;
      rejectVerification = reject;
    });

    let authentication: Promise<OAuthAppAuthentication>;
    const starting = verification.then((value) => {''',
    '''    let verificationReceived = false;
    const verification = Promise.withResolvers<Verification>();

    let authentication: Promise<OAuthAppAuthentication>;
    const starting = verification.promise.then((value) => {''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''          resolveVerification?.(value);''',
    '''          verification.resolve(value);''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''            rejectVerification?.(
              new Error("GitHub device authorization completed without verification."),
            );''',
    '''            verification.reject(
              new Error("GitHub device authorization completed without verification."),
            );''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''        (error: unknown) => rejectVerification?.(error),''',
    '''        (error: unknown) => verification.reject(error),''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''      rejectVerification?.(error);''',
    '''      verification.reject(error);''',
)
replace_once(
    "packages/github/src/deviceFlow.test.ts",
    '''    let verify: ((value: unknown) => void) | null = null;
    deviceAuth.create.mockImplementation(
      (options: { onVerification: (value: unknown) => void }) => {
        verify = options.onVerification;''',
    '''    const verification = { current: null as ((value: unknown) => void) | null };
    deviceAuth.create.mockImplementation(
      (options: { onVerification: (value: unknown) => void }) => {
        verification.current = options.onVerification;''',
)
replace_once(
    "packages/github/src/deviceFlow.test.ts",
    '''    verify?.({''',
    '''    verification.current?.({''',
)

command_palette = Path("apps/web/src/components/CommandPalette.tsx")
text = command_palette.read_text()
start_marker = "  const startAddProjectSourceSelection = useCallback("
end_marker = "  const addProjectEnvironmentItems: CommandPaletteActionItem[] ="
if text.count(start_marker) != 1 or text.count(end_marker) != 1:
    raise RuntimeError("Command Palette source-selection markers are not unique")
prefix, remainder = text.split(start_marker, 1)
section, suffix = remainder.split(end_marker, 1)
old_guard = '''      if (!canCreateProjectInEnvironment(environment?.connection.phase)) {'''
new_guard = '''      if (
        environment === undefined ||
        !canCreateProjectInEnvironment(environment.connection.phase)
      ) {'''
if section.count(old_guard) != 1:
    raise RuntimeError(f"Scoped environment guard count was {section.count(old_guard)}")
section = section.replace(old_guard, new_guard, 1)
command_palette.write_text(prefix + start_marker + section + end_marker + suffix)
