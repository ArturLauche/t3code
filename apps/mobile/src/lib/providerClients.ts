import {
  isProviderDriverKind,
  ProviderDriverKind,
  ClineSettings,
  FreebuffSettings,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { defineProviderClient, makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";

/**
 * Cline and Freebuff are fork-only drivers, so their client definitions live
 * beside the registry that renders them rather than in a provider package.
 */
const clineClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("cline"),
  label: "Cline",
  badgeLabel: "Early Access",
  settingsSchema: ClineSettings,
  supportsCloudExecution: false,
  icon: {
    viewBox: "0 0 92 96",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        fillRule: "nonzero",
        d: "M65.4492701,16.3 C76.3374701,16.3 85.1635558,25.16479 85.1635558,36.1 L85.1635558,42.7 L90.9027661,54.1647464 C91.4694141,55.2966923 91.4668177,56.6300535 90.8957658,57.7597839 L85.1635558,69.1 L85.1635558,75.7 C85.1635558,86.63554 76.3374701,95.5 65.4492701,95.5 L26.0206986,95.5 C15.1328272,95.5 6.30641291,86.63554 6.30641291,75.7 L6.30641291,69.1 L0.448507752,57.7954874 C-0.14693501,56.6464093 -0.149634367,55.2802504 0.441262896,54.1288283 L6.30641291,42.7 L6.30641291,36.1 C6.30641291,25.16479 15.1328272,16.3 26.0206986,16.3 L65.4492701,16.3 Z M62.9301895,22 L29.189529,22 C19.8723267,22 12.3191987,29.5552188 12.3191987,38.875 L12.3191987,44.5 L7.44288578,53.9634655 C6.84794449,55.1180686 6.85066096,56.4896598 7.45017099,57.6418974 L12.3191987,67 L12.3191987,72.625 C12.3191987,81.9450625 19.8723267,89.5 29.189529,89.5 L62.9301895,89.5 C72.2476729,89.5 79.8005198,81.9450625 79.8005198,72.625 L79.8005198,67 L84.5682187,57.6061395 C85.1432011,56.473244 85.1458141,55.1345713 84.5752587,53.9994398 L79.8005198,44.5 L79.8005198,38.875 C79.8005198,29.5552188 79.8005198,22 62.9301895,22 Z",
      },
      {
        d: "M45.7349843,0.5 C51.6587423,0.5 56.7349843,5.5762423 56.7349843,11.5 C56.7349843,17.4237577 51.6587423,22.5 45.7349843,22.5 C39.8112263,22.5 34.7349843,17.4237577 34.7349843,11.5 C34.7349843,5.5762423 39.8112263,0.5 45.7349843,0.5 Z",
      },
      {
        d: "M31,45 L36,45 Q38.5,45 38.5,47.5 L38.5,64.5 Q38.5,67 36,67 L31,67 Q28.5,67 28.5,64.5 L28.5,47.5 Q28.5,45 31,45 Z",
      },
      {
        d: "M55,45 L60,45 Q62.5,45 62.5,47.5 L62.5,64.5 Q62.5,67 60,67 L55,67 Q52.5,67 52.5,64.5 L52.5,47.5 Q52.5,45 55,45 Z",
      },
    ],
  },
});

const freebuffClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("freebuff"),
  label: "Freebuff",
  badgeLabel: "Experimental",
  settingsSchema: FreebuffSettings,
  supportsCloudExecution: false,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "currentColor", dark: "currentColor" },
    paths: [
      { d: "M4 5.5 L20 5.5 L20 18.5 L4 18.5 Z" },
      { d: "M7 9 L7 15 M10 12 L7 9 L7 15" },
      { d: "M14 12 L19 12" },
    ],
  },
});

/** The provider client definitions this mobile build ships. */
const providerClients = makeProviderClientRegistry([
  cursorClient,
  clineClient,
  freebuffClient,
  grokClient,
  museClient,
  openCodeClient,
  piClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
