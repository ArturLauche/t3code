/**
 * Screens captured from the real Freebuff CLI, used to keep the screen
 * classifier honest against the TUI it actually has to read.
 *
 * Captured on Freebuff 0.1.6 in a 160x48 terminal through the same PTY and
 * headless-terminal path the adapter uses. They record what the CLI renders
 * today, not what any release is promised to render: Freebuff's TUI is not a
 * stable protocol, and the provider is marked `uncharacterized` in the model
 * manifest for exactly that reason. A change in the real CLI shows up here as a
 * failing fixture rather than as a user staring at a timeout.
 *
 * Login URLs are redacted; the one-time codes they carry are single-use and not
 * worth persisting.
 */
const INDENT = " ".repeat(48);

/** The screen an unauthenticated CLI shows once the login link is printed. */
export const FREEBUFF_LOGIN_SCREEN_0_1_6 = [
  `${INDENT}███████████                        ██                 ▄████  ▄██`,
  `${INDENT}███▀▀▀▀▀▀▀▀                        ██                 ██    ██▀`,
  `${INDENT}███ █████  ██████ ▄█████   ▄████▄  ██████▄  ██   ██ ████████████`,
  `${INDENT}███ ███▀▀  ██▀   ███▄▄▄██ ██▄▄▄███ ██   ▀██ ██   ██   ██    ██`,
  `${INDENT}███ ███    ███   ███▀▀▀▀▀ ██▀▀▀▀▀  ██▄  ▄██ ██▄  ██   ██    ██`,
  `${INDENT}███ ██▀    ██▀    ▀█████   ▀████▀  ██████▀   ▀████▀   ██    ██`,
  `${INDENT}Open this URL in your browser to login:`,
  "                                           https://freebuff.com/login?auth_code=<redacted>",
  "                                                        [ Copy link (c) ]",
  `${INDENT}Waiting for login...`,
].join("\n");

/** The screen shown before the login link, prompting for the Enter key. */
export const FREEBUFF_ENTER_TO_LOGIN_SCREEN_0_1_6 =
  `${INDENT}███████████                        ██                 ▄████  ▄██\n` +
  `${INDENT}Press ENTER to login...`;
