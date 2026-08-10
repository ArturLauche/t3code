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
