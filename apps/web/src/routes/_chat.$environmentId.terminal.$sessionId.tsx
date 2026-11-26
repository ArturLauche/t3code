import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";

import { TerminalSessionView } from "../components/TerminalSessionView";

export const Route = createFileRoute("/_chat/$environmentId/terminal/$sessionId")({
  component: TerminalSessionRoute,
});

function TerminalSessionRoute() {
  const { environmentId, sessionId } = Route.useParams();
  return (
    <TerminalSessionView environmentId={EnvironmentId.make(environmentId)} sessionId={sessionId} />
  );
}
