import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AgentChat } from "./AgentChat";
import { buildAgentContextChips, removeAgentContextSearch } from "./agent-chat-context";

export function AgentWorkspace() {
  const { t } = useTranslation();
  const search = useSearch({ from: "/agent" });
  const navigate = useNavigate({ from: "/agent" });
  const contextChips = buildAgentContextChips(search, t);
  const agentId = search["domain"] === "flood-water" ? "flood-situation" : "integrity-orchestrator";
  const removeContext = (chip: (typeof contextChips)[number]) => {
    void navigate({ search: (previous) => removeAgentContextSearch(previous, chip), replace: true });
  };

  return <main id="main-content" className="agent-workspace" tabIndex={-1} aria-label={t("agentWorkspace")}>
    <header className="agent-workspace-heading">
      <div><p className="eyebrow">{t("agentWorkspaceEyebrow")}</p><h1>{t("agentWorkspace")}</h1></div>
      <Link to="/map" search={() => search}>{t("mapNav")}</Link>
    </header>
    <AgentChat variant="workspace" contextChips={contextChips} onRemoveContext={removeContext} agentId={agentId} />
  </main>;
}
