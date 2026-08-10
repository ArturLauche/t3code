from pathlib import Path

path = Path("packages/client-runtime/src/connection/onboarding.test.ts")
text = path.read_text()
old = '          connectionId: "sandbox:daytona:work:sandbox-42",'
new = '          connectionId: "sandbox:daytona:daytona%3Awork:sandbox-42",'
if text.count(old) != 1:
    raise RuntimeError(f"Expected one stale sandbox connection id, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
