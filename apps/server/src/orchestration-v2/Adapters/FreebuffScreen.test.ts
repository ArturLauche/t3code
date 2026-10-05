import { describe, expect, it } from "@effect/vitest";

import {
  classifyFreebuffScreen,
  extractVisibleAssistantText,
  mergeVisibleAssistantText,
} from "./FreebuffScreen.ts";
import {
  FREEBUFF_ENTER_TO_LOGIN_SCREEN_0_1_6,
  FREEBUFF_LOGIN_SCREEN_0_1_6,
} from "../../provider/Layers/freebuffScreens.ts";

/**
 * The screen rules are what decides whether a Freebuff turn is running, needs
 * a sign-in, or is answering, so they are exercised against captured screens
 * rather than a live TUI.
 */
describe("Freebuff screen classification", () => {
  it("recognizes current Freebuff gates without matching assistant prose in chat", () => {
    expect(classifyFreebuffScreen("Press ENTER to login...").kind).toBe("authentication");
    expect(classifyFreebuffScreen("Start coding for free\nGLM 5.3 Flash").kind).toBe("landing");
    expect(classifyFreebuffScreen("Freebuff is already running\nTake over").kind).toBe("blocked");
    expect(
      classifyFreebuffScreen(
        "Another freebuff instance took over this account.\nOnly one CLI per account can be active at a time.\nClose the other instance, then restart freebuff here.",
      ).kind,
    ).toBe("blocked");
    expect(
      classifyFreebuffScreen(
        "freebuff found agent files in this repository it has not run before:\n  /workspace/project/.agents\nLoad and run these? [y/N]",
      ).kind,
    ).toBe("blocked");
    expect(classifyFreebuffScreen("thinking...\nEnter a coding task or / for commands").kind).toBe(
      "busy",
    );
    expect(
      classifyFreebuffScreen(
        "Freebuff is already running\nTake over\nEnter a coding task or / for commands",
      ).kind,
    ).toBe("blocked");
    expect(
      classifyFreebuffScreen("Freebuff is already running\nEnter a coding task or / for commands")
        .kind,
    ).toBe("chat");
    expect(
      classifyFreebuffScreen(
        `Start coding for free\n${Array.from({ length: 130 }, () => "historical output").join("\n")}\nEnter a coding task or / for commands`,
      ).kind,
    ).toBe("chat");
    expect(
      classifyFreebuffScreen(
        `login required\n${Array.from({ length: 130 }, () => "historical output").join("\n")}\nEnter a coding task or / for commands`,
      ).kind,
    ).toBe("chat");
    expect(
      classifyFreebuffScreen("login required\nEnter a coding task or / for commands").kind,
    ).toBe("chat");
    expect(
      classifyFreebuffScreen(
        "> fix the login required redirect\nEnter a coding task or / for commands",
      ).kind,
    ).toBe("chat");
    expect(classifyFreebuffScreen("loading...").kind).toBe("busy");
    expect(
      classifyFreebuffScreen(
        "╭────────────╮\n│ thinking... 2s ■ Esc │\n│ Enter a coding task │\n╰────────────╯",
      ).kind,
    ).toBe("busy");
    expect(
      classifyFreebuffScreen("thinking... 2s ■ Esc\nEnter a coding task or / for commands").kind,
    ).toBe("busy");
  });
});

describe("extractVisibleAssistantText", () => {
  it("removes bordered composer chrome from visible output", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "╭────────────╮\n│ Enter a coding task │\n╰────────────╯",
        current:
          "╭────────────╮\n│ Enter a coding task │\n│ > Explain │\n│ answer │\n╰────────────╯",
        prompt: "Explain",
      }),
    ).toBe("answer");
  });

  it("preserves Markdown delimiters while removing composer borders", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current: "Enter a coding task or / for commands\n> Explain\n│ `code` │\n│ | a | b | │",
        prompt: "Explain",
      }),
    ).toBe("`code`\n| a | b |");
  });

  it("anchors extraction at the end of a wrapped user prompt", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current:
          "Enter a coding task or / for commands\n> This is a long user prompt that wraps\n  continuation line\nanswer",
        prompt: "This is a long user prompt that wraps\ncontinuation line",
      }),
    ).toBe("answer");
  });

  it("anchors extraction at the newest timestamped user bubble", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "[09:41]\ntest\nold answer",
        current:
          "[09:41]\ntest\nold answer\n[09:42]\ntest\nThis is a test\nFreebuff will run commands on your behalf to help you build.",
        prompt: "test",
      }),
    ).toBe("This is a test");
  });

  it("finds a wrapped prompt inside a timestamped user bubble", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Freebuff",
        current:
          "Freebuff\n[09:42]\nThis is a long user prompt that wraps\ncontinuation line\nanswer",
        prompt: "This is a long user prompt that wraps\ncontinuation line",
      }),
    ).toBe("answer");
  });

  it("anchors extraction at the user prompt when the answer repeats it", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current: "Enter a coding task or / for commands\n> test\nThis is a test",
        prompt: "test",
      }),
    ).toBe("This is a test");
  });

  it("anchors repeated non-timestamped prompts at the newest turn", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands\n> Explain\nold answer",
        current:
          "Enter a coding task or / for commands\n> Explain\nold answer\n> Explain\nnew answer\nEnter a coding task or / for commands",
        prompt: "Explain",
      }),
    ).toBe("new answer");
  });

  it("does not treat a prompt-only screen as assistant output", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current:
          "Enter a coding task or / for commands\n> Explain\nEnter a coding task or / for commands",
        prompt: "Explain",
      }),
    ).toBe("");
  });

  it("merges overlapping terminal snapshots without duplicating scrolled lines", () => {
    expect(mergeVisibleAssistantText("line 1\nline 2", "line 2\nline 3")).toBe(
      "line 1\nline 2\nline 3",
    );
    expect(mergeVisibleAssistantText("line 1", "line 1")).toBe("line 1");
  });

  it("strips echoed attachment context from assistant output", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current:
          'Enter a coding task or / for commands\n> Explain\n[Attached file "notes.txt" is saved at: /tmp/notes.txt]\nanswer',
        prompt: "Explain",
      }),
    ).toBe("answer");
  });

  it("keeps bracketed assistant text that is not attachment context", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current:
          "Enter a coding task or / for commands\n> Explain\n[Attached file discussion]\nanswer",
        prompt: "Explain",
      }),
    ).toBe("[Attached file discussion]\nanswer");
  });

  it("strips echoed runtime instructions from assistant output", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current:
          "Enter a coding task or / for commands\n> Explain\n<runtime_info>\ninternal context\n</runtime_info>\nanswer",
        prompt: "Explain",
      }),
    ).toBe("answer");
  });

  it("keeps repeated output and blank lines after the submitted prompt", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Freebuff\n> Explain",
        current:
          "Freebuff\n> Explain\n\nrepeated line\n\nrepeated line\n\nEnter a coding task or / for commands",
        prompt: "Explain",
      }),
    ).toBe("repeated line\n\nrepeated line");
  });
});

describe("classifyFreebuffScreen against the real Freebuff TUI", () => {
  it("recognises the login screen Freebuff 0.1.6 renders", () => {
    // Captured through the same PTY and headless-terminal path the adapter
    // uses. Reading this as anything but `authentication` is what turned a
    // missing sign-in into a 30-second "did not reach its chat screen" timeout
    // instead of the actionable "run `freebuff login`".
    expect(classifyFreebuffScreen(FREEBUFF_LOGIN_SCREEN_0_1_6)).toMatchObject({
      kind: "authentication",
    });
  });

  it("recognises the Enter prompt shown before the login link", () => {
    expect(classifyFreebuffScreen(FREEBUFF_ENTER_TO_LOGIN_SCREEN_0_1_6)).toMatchObject({
      kind: "authentication",
    });
  });

  it("does not read an answer about signing in as a login overlay", () => {
    // The gate is provider chrome above the conversation. A turn that quotes
    // the phrase on its own line must keep running.
    const answer = [
      "Enter a coding task or / for commands",
      "[10:04] fix the login required redirect",
      "waiting for login...",
      "",
      "The route now redirects to /sign-in.",
      "Enter a coding task or / for commands",
    ].join("\n");
    expect(classifyFreebuffScreen(answer).kind).not.toBe("authentication");
  });
});
