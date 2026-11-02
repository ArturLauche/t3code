/**
 * Screens captured from Freebuff 0.1.6 through the adapter's PTY path, so the
 * classifier is tested against the TUI it reads. Login URLs are redacted.
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
