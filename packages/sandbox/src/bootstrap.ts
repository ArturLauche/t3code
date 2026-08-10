import * as NodeBuffer from "node:buffer";

export const T3_SANDBOX_SERVER_PORT = 3773;

function shellScriptCommand(script: string, ...args: readonly string[]): string {
  const encoded = NodeBuffer.Buffer.from(script, "utf8").toString("base64");
  const quotedArgs = args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
  return `printf '%s' '${encoded}' | base64 -d | sh -s --${quotedArgs ? ` ${quotedArgs}` : ""}`;
}

const launchScript = `set -eu
STATE_DIR="$HOME/.t3/cloud-launch/t3"
SERVER_HOME="$HOME/.t3"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"
PID_FILE="$STATE_DIR/pid"
LOG_FILE="$STATE_DIR/server.log"
PORT="$1"
wait_for_exit() {
  WAIT_PID="$1"
  WAIT_COUNT=0
  while kill -0 "$WAIT_PID" 2>/dev/null; do
    if [ "$WAIT_COUNT" -ge 50 ]; then
      printf 'Timed out waiting for T3 server process %s to exit.\n' "$WAIT_PID" >&2
      return 1
    fi
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
}
mkdir -p "$STATE_DIR"
cat >"$RUNNER_NEXT" <<'RUNNER'
@@RUNNER@@
RUNNER
CHANGED=0
if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  CHANGED=1
fi
mv "$RUNNER_NEXT" "$RUNNER_FILE"
chmod 700 "$RUNNER_FILE"
PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ "$CHANGED" -eq 1 ] && [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  wait_for_exit "$PID"
  PID=""
fi
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  nohup env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 0.0.0.0 --port "$PORT" --base-dir "$SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
  PID="$!"
  printf '%s\n' "$PID" >"$PID_FILE"
fi
READY=0
COUNT=0
while [ "$COUNT" -lt 120 ]; do
  if node -e 'const http=require("node:http");const p=Number(process.argv[1]);const r=http.get({host:"127.0.0.1",port:p,path:"/",timeout:1000},x=>{x.resume();process.exit(x.statusCode>=200&&x.statusCode<500?0:1)});r.on("timeout",()=>{r.destroy();process.exit(1)});r.on("error",()=>process.exit(1))' "$PORT" >/dev/null 2>&1; then
    READY=1
    break
  fi
  COUNT=$((COUNT + 1))
  sleep 0.25
done
if [ "$READY" -ne 1 ]; then
  tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
  exit 1
fi
printf '{"remotePort":%s}\n' "$PORT"
`;

const pairingScript = `set -eu
RUNNER_FILE="$HOME/.t3/cloud-launch/t3/run-t3.sh"
if [ ! -x "$RUNNER_FILE" ]; then
  printf 'T3 sandbox runner is not installed.\n' >&2
  exit 1
fi
"$RUNNER_FILE" auth pairing create --base-dir "$HOME/.t3" --json
`;

const stopScript = `set -eu
STATE_DIR="$HOME/.t3/cloud-launch/t3"
PID_FILE="$STATE_DIR/pid"
PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  COUNT=0
  while kill -0 "$PID" 2>/dev/null; do
    if [ "$COUNT" -ge 50 ]; then
      printf 'Timed out waiting for T3 server process %s to exit.\n' "$PID" >&2
      exit 1
    fi
    COUNT=$((COUNT + 1))
    sleep 0.1
  done
fi
rm -f "$PID_FILE"
`;

export function buildSandboxLaunchCommand(
  runnerScript: string,
  port = T3_SANDBOX_SERVER_PORT,
): string {
  return shellScriptCommand(launchScript.replace("@@RUNNER@@", runnerScript), String(port));
}

export function buildSandboxPairingCommand(): string {
  return shellScriptCommand(pairingScript);
}

export function buildSandboxStopCommand(): string {
  return shellScriptCommand(stopScript);
}

export function parseSandboxPairingCredential(stdout: string): string {
  for (const candidate of stdout.match(/\{[^\n]*\}/gu)?.toReversed() ?? []) {
    try {
      const value = JSON.parse(candidate) as { credential?: unknown };
      if (typeof value.credential === "string" && value.credential.trim()) {
        return value.credential;
      }
    } catch {
      // Installation progress can contain non-JSON lines before the final result.
    }
  }
  throw new Error("The sandbox T3 server did not return a pairing credential.");
}
