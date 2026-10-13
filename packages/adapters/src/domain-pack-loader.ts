import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { parseAgentDefinition, parseDomainPack, type AgentDefinition, type DomainPack } from "@fieldloop/contracts";

export interface LoadedDomainPack {
  content: DomainPack;
  agents: AgentDefinition[];
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

/** Validate the complete catalog before exposing it to any runtime or database. */
export async function loadDomainPacks(root: URL | string, toolRegistry: ReadonlySet<string>, requiredPacks: readonly string[] = []): Promise<LoadedDomainPack[]> {
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
    packs.push({ content, agents });
  }
  if (!packs.length) throw new Error(`${rootPath}: no Domain Packs found`);
  for (const id of requiredPacks) {
    if (!packs.some(({ content }) => content.id === id)) throw new Error(`${rootPath}/${id}/pack.yaml: required pack missing`);
  }
  const agents = new Map(packs.flatMap((pack) => pack.agents.map((agent) => [agent.id, agent] as const)));
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
