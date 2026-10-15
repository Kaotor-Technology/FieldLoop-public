import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { parseAgentDefinition, parseDomainPack, parseGenAiSafetyPack, type GenAiSafetyPack, type AgentDefinition, type DomainPack } from "@fieldloop/contracts";

export interface LoadedDomainPack {
  content: DomainPack;
  agents: AgentDefinition[];
  aiSafety?: GenAiSafetyPack;
}

async function readYaml(file: string, directory: string): Promise<unknown> {
  const resolved = await realpath(file);
  const path = relative(directory, resolved);
  if (isAbsolute(path) || path.startsWith("..")) throw new Error(`${file}: file escapes the pack directory`);
  const document = parseDocument(await readFile(resolved, "utf8"), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`${file}: invalid YAML: ${document.errors.map(({ message }) => message).join("; ")}`);
  // Bound alias expansion; YAML documents cannot execute code.
  try { return document.toJS({ maxAliasCount: 50 }) as unknown; }
  catch { throw new Error(`${file}: invalid YAML aliases`); }
}

function requireUnique(values: string[], file: string, kind: string) {
  if (new Set(values).size !== values.length) throw new Error(`${file}: Duplicate ${kind}`);
}

function validateContent(content: DomainPack, file: string) {
  requireUnique(content.signalRules.map(({ id }) => id), file, "rule");
  requireUnique(content.threatCategories.map(({ code }) => code), file, "Threat Category");
  requireUnique(content.warningTemplates.map(({ id }) => id), file, "warning template");
  for (const rule of content.signalRules) {
    if (rule.targetBarrierSelector.pack !== content.id) throw new Error(`${file}: rule ${rule.id} selector crosses packs`);
    for (const ring of rule.spatialGeometry?.coordinates ?? []) {
      if (JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))) throw new Error(`${file}: rule ${rule.id} spatial ring must be closed`);
    }
  }
  for (const template of content.warningTemplates) {
    for (const language of ["en", "th"] as const) {
      const placeholders = [...template[language].matchAll(/\{\{([a-z][a-zA-Z]*)\}\}/g)].map((match) => match[1]);
      if (template.placeholders.some((name) => !placeholders.includes(name))
          || placeholders.some((name) => !template.placeholders.includes(name ?? ""))) {
        throw new Error(`${file}: ${template.id}.${language} has missing or undeclared placeholders`);
      }
      if (!template[language].includes(content.label)) throw new Error(`${file}: ${template.id}.${language} requires ${content.label}`);
    }
  }
}

function validateAiSafety(safety: GenAiSafetyPack, content: DomainPack, file: string, tools: ReadonlySet<string>) {
  const reject = (reason: string): never => { throw new Error(`${file}: ${reason}`); };
  if (safety.version !== content.version || safety.label !== content.label
      || safety.classification !== content.classification) reject("AI Safety metadata must match its pack");
  const { aiSystem, bowtie, policies } = safety;
  for (const tool of aiSystem.tools) if (!tools.has(tool)) reject(`unknown tool ${tool}`);
  for (const [kind, items] of [
    ["policy", policies], ["Barrier", bowtie.barriers], ["Threat", bowtie.threats],
    ["Consequence", bowtie.consequences], ["path", bowtie.paths],
  ] as const) requireUnique(items.map(({ id }) => id), file, kind);
  requireUnique(policies.map(({ kind }) => kind), file, "policy kind");
  requireUnique(policies.map(({ barrierId }) => barrierId), file, "policy Barrier mapping");
  const barriers = new Map(bowtie.barriers.map((barrier) => [barrier.id, barrier]));
  const categories = new Set(content.threatCategories.map(({ code }) => code));
  for (const threat of bowtie.threats) if (!categories.has(threat.categoryCode)) reject(`unknown Threat Category ${threat.categoryCode}`);
  for (const policy of policies) {
    const barrier = barriers.get(policy.barrierId);
    if (!barrier || barrier.type !== "technical" || barrier.implementation !== "tier-1-configured") {
      reject(`policy ${policy.id} must map to a configured Technical Barrier`);
    }
    if (barrier?.side !== (policy.kind === "output-dlp" ? "mitigative" : "preventive")) reject(`policy ${policy.id} has the wrong Barrier side`);
    if (policy.kind === "classification-routing") {
      requireUnique(policy.settings.routes.map(({ classification }) => classification), file, "classification route");
      if (policy.settings.routes.length !== aiSystem.dataClasses.length) reject("classification routing must cover every data class");
      for (const route of policy.settings.routes) {
        if (!aiSystem.dataClasses.includes(route.classification)) reject("unknown data class route");
        for (const tier of route.allowedModelTiers) {
          if (!aiSystem.modelRoutes.some((model) => model.tier === tier && model.enabled)) reject(`no enabled model tier ${tier}`);
          if (tier !== "private") reject("demo routing must remain inside the private boundary");
        }
      }
    }
    if (policy.kind === "tool-call" && (policy.settings.allowedTools.length !== aiSystem.tools.length
        || aiSystem.tools.some((tool) => !policy.settings.allowedTools.includes(tool)))) reject("tool policy must match the AI System allowlist");
  }
  if (!aiSystem.modelRoutes.some((route) => route.tier === aiSystem.modelTier && route.enabled)
      || aiSystem.modelRoutes.some((route) => route.tier === "public-saas" && route.enabled
        || route.tier === "private" && route.boundary !== "private-in-country-no-retention")) reject("invalid model boundary or default tier");
  const usedBarriers = new Set<string>();
  const targets = new Set<string>();
  for (const path of bowtie.paths) {
    const collection = path.side === "preventive" ? bowtie.threats : bowtie.consequences;
    if (!collection.some(({ id }) => id === path.targetId)) reject(`unknown path target ${path.targetId}`);
    const targetKey = `${path.side}:${path.targetId}`;
    if (targets.has(targetKey)) reject(`Duplicate path target ${path.targetId}`);
    targets.add(targetKey);
    for (const id of path.barrierIds) {
      if (barriers.get(id)?.side !== path.side) reject(`unknown or incompatible path Barrier ${id}`);
      usedBarriers.add(id);
    }
  }
  if (usedBarriers.size !== barriers.size || targets.size !== bowtie.threats.length + bowtie.consequences.length) reject("Bowtie paths must cover every Threat, Consequence and Barrier");
  for (const id of bowtie.independenceGroup.barrierIds) {
    if (barriers.get(id)?.implementation !== "tier-1-configured") reject(`invalid Independence Group Barrier ${id}`);
  }
  if (bowtie.barriers.some((barrier) => barrier.implementation === "tier-1-configured"
      && !bowtie.independenceGroup.barrierIds.includes(barrier.id))) reject("shared gateway Barriers require their Independence Group");
  for (const barrier of bowtie.barriers) {
    requireUnique(barrier.degradationFactors.map(({ id }) => id), file, "Degradation Factor");
    for (const factor of barrier.degradationFactors) requireUnique(factor.controls.map(({ id }) => id), file, "Degradation Control");
  }
  for (const link of bowtie.crossDomainLinks) {
    if (!bowtie.consequences.some(({ id }) => id === link.fromConsequenceId) || link.targetPack === content.id) reject("invalid Cross-Domain template reference");
  }
}

/** Validate the complete catalog before exposing it to any runtime or database. */
export async function loadDomainPacks(root: URL | string, toolRegistry: ReadonlySet<string>, requiredPacks: readonly string[] = [], registeredOperations: ReadonlySet<string> = toolRegistry): Promise<LoadedDomainPack[]> {
  const rootPath = await realpath(typeof root === "string" ? root : fileURLToPath(root));
  const packs: LoadedDomainPack[] = [];
  const sources = new Map<string, string>();
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    if (requiredPacks.length && !requiredPacks.includes(entry.name)) continue;
    const directory = await realpath(join(rootPath, entry.name));
    if (!requiredPacks.length && !(await readdir(directory)).includes("pack.yaml")) continue;
    const file = join(directory, "pack.yaml");
    const content = parseDomainPack(await readYaml(file, directory), file);
    if (content.id !== entry.name) throw new Error(`${file}: pack ID must match its directory`);
    validateContent(content, file);
    const agents: AgentDefinition[] = [];
    for (const agentFile of content.agentFiles) {
      const path = join(directory, agentFile);
      const agent = parseAgentDefinition(await readYaml(path, directory), path);
      if (sources.has(agent.id)) throw new Error(`${path}: Duplicate agent ${agent.id}`);
      for (const tool of agent.allowedTools) {
        if (!toolRegistry.has(tool)) throw new Error(`${path}: unknown tool ${tool}`);
      }
      if (agent.knowledgeFolders.some((folder) => !content.knowledgeFolders.includes(folder))) {
        throw new Error(`${path}: unknown Knowledge Library folder`);
      }
      if (agent.kind === "specialist" && agent.delegates.length) throw new Error(`${path}: specialist cannot delegate`);
      sources.set(agent.id, path);
      agents.push(agent);
    }
    const aiSafety = content.aiSafetyFile
      ? parseGenAiSafetyPack(await readYaml(join(directory, content.aiSafetyFile), directory), join(directory, content.aiSafetyFile))
      : undefined;
    if (aiSafety) validateAiSafety(aiSafety, content, join(directory, content.aiSafetyFile ?? "ai-safety.yaml"), registeredOperations);
    packs.push({ content, agents, ...(aiSafety ? { aiSafety } : {}) });
  }
  if (!packs.length) throw new Error(`${rootPath}: no Domain Packs found`);
  for (const id of requiredPacks) {
    if (!packs.some(({ content }) => content.id === id)) throw new Error(`${rootPath}/${id}/pack.yaml: required pack missing`);
  }
  const agents = new Map(packs.flatMap((pack) => pack.agents.map((agent) => [agent.id, agent] as const)));
  for (const pack of packs) {
    if (!pack.aiSafety) continue;
    const { aiSystem } = pack.aiSafety;
    const source = `${rootPath}/${pack.content.id}/${pack.content.aiSafetyFile}`;
    const lineUp = packs.find(({ content }) => content.id === aiSystem.agentPack)?.agents;
    if (!lineUp || lineUp.length !== aiSystem.agentIds.length || lineUp.some((agent) =>
      !aiSystem.agentIds.includes(agent.id) || agent.aiSystemId !== aiSystem.id || agent.useCase !== aiSystem.useCase
      || agent.allowedTools.some((tool) => !aiSystem.tools.includes(tool)))) {
      throw new Error(`${source}: AI System line-up or tool vocabulary does not match its Agent pack`);
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(agent: AgentDefinition) {
    if (visiting.has(agent.id)) throw new Error(`${sources.get(agent.id)}: delegate cycle involving ${agent.id}`);
    if (visited.has(agent.id)) return;
    visiting.add(agent.id);
    for (const id of agent.delegates) {
      const delegate = agents.get(id);
      if (!delegate || delegate.useCase !== agent.useCase || delegate.aiSystemId !== agent.aiSystemId) {
        throw new Error(`${sources.get(agent.id)}: unknown or incompatible delegate ${id}`);
      }
      visit(delegate);
    }
    visiting.delete(agent.id);
    visited.add(agent.id);
  }
  for (const agent of agents.values()) visit(agent);
  return packs;
}
