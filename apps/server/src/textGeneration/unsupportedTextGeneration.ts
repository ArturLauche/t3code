/**
 * TextGeneration stub for drivers that cannot serve background text without a
 * full interactive turn. Reaching it is a configuration error, not a fallback.
 */
import { type ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { TextGeneration } from "./TextGeneration.ts";

const reject =
  (driverKind: ProviderDriverKind) =>
  (operation: string): Effect.Effect<never, TextGenerationError> =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `${driverKind} does not support background text generation. Pick another provider for titles, branch names, commit messages, pull request descriptions and review guides.`,
      }),
    );

export const makeUnsupportedTextGeneration = (
  driverKind: ProviderDriverKind,
): TextGeneration["Service"] => {
  const fail = reject(driverKind);
  return {
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
    generateReviewGuide: () => fail("generateReviewGuide"),
    generateTranscriptionPostProcessing: () => fail("generateTranscriptionPostProcessing"),
  };
};
