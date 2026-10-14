import bowtieASeed from "../../../data/synthetic/dl-01/bowtie-a.json";
import bowtieDSeed from "../../../data/synthetic/bangkok/bowtie-d.json";

export type BowtieCode = "A" | "C" | "D";
export type BarrierHealth = "healthy" | "degraded" | "failed" | "unverified";
export type TriadDimension = "effective" | "independent" | "auditable";

export interface BowtieView {
  id: string;
  code: BowtieCode;
  title: string;
  domain: string;
  hazard: string;
  topEvent: string;
  provenance: string;
  classification: string;
  threats: Array<{ id: string; name: string }>;
  consequences: Array<{ id: string; name: string }>;
  barriers: Array<{
    id: string;
    name: string;
    type: string;
    side: "preventive" | "mitigative";
    health: BarrierHealth;
    degradationFactors: Array<{ id: string; description: string; controls: string[] }>;
    triad: Partial<Record<TriadDimension, { pass: boolean; justification?: string }>>;
  }>;
  independenceGroups: Array<{ id: string; cause: string; barrierIds: string[] }>;
}

interface RawBowtieSeed {
  id: string;
  hazard: string;
  topEvent: string;
  domain: string;
  assetCode?: string;
  metadata?: { label?: string; simulated?: boolean; classification?: string };
  threats?: Array<{ id: string; name: string }>;
  consequences?: Array<{ id: string; name: string }>;
  barriers?: Array<{
    id: string;
    name: string;
    type: string;
    side: string;
    health?: string;
    triad?: Partial<Record<TriadDimension, { pass: boolean; justification?: string }>>;
    degradationFactors?: Array<{
      id: string;
      description: string;
      controls?: Array<{ id: string; description: string }>;
    }>;
  }>;
  independenceGroups?: Array<{ id: string; cause: string; barrierIds?: string[] }>;
}

// Bowtie C's presentation content follows PRD §6.1-C. Its Health is
// Unverified because the UI has no operational Evidence source for this pack.
const bowtieCSeed: RawBowtieSeed = {
  id: "uc-1-bowtie-c",
  hazard: "An LLM with access to Highly Restricted documents",
  topEvent: "Restricted content or unsafe advice leaves the AI System",
  domain: "gen_ai",
  metadata: { label: "SYNTHETIC", simulated: true, classification: "CONFIDENTIAL" },
  threats: [
    { id: "indirect-prompt-injection", name: "Indirect prompt injection in an uploaded contractor PDF" },
    { id: "restricted-data-in-external-app", name: "User pastes restricted data into an external-model app" },
    { id: "hallucinated-engineering-clause", name: "Hallucinated clause in an engineering answer" },
    { id: "agent-asset-database-write", name: "Agent tries to write to an asset database" },
  ],
  consequences: [
    { id: "restricted-asset-data-disclosure", name: "Disclosure of restricted Asset data" },
    { id: "wrong-engineering-decision", name: "Wrong engineering decision" },
  ],
  independenceGroups: [{
    id: "shared-guardrail-runtime",
    cause: "Shared Guardrail gateway and Tier 1 detector availability (SIMULATION)",
    barrierIds: ["injection-detector", "tool-allowlist", "classification-routing", "dlp-redaction", "tool-call-policy", "output-dlp"],
  }],
  barriers: [
    {
      id: "injection-detector", name: "Injection detector (Tier 1)", type: "technical", side: "preventive",
      health: "unverified", degradationFactors: [{ id: "detector-drift", description: "Detector drift", controls: [{ id: "red-team-evaluation", description: "Monthly red-team evaluation" }] }],
      triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
    {
      id: "retrieved-text-as-data", name: "Retrieved text treated as data", type: "organisational", side: "preventive",
      health: "unverified", triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
    {
      id: "tool-allowlist", name: "Tool allowlist", type: "technical", side: "preventive",
      health: "unverified", triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
    {
      id: "classification-routing", name: "Classification routing to private tier (Tier 1)", type: "technical", side: "preventive",
      health: "unverified", degradationFactors: [{ id: "unlabelled-document-types", description: "New document types unlabelled", controls: [{ id: "labelling-sla", description: "Labelling SLA" }] }],
      triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
    {
      id: "dlp-redaction", name: "DLP redaction", type: "technical", side: "preventive",
      health: "unverified", triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
    {
      id: "grounding-check", name: "Grounding check (Tier 2)", type: "technical", side: "preventive",
      health: "unverified", degradationFactors: [{ id: "missing-current-edition", description: "Library missing current edition", controls: [{ id: "revision-guard", description: "Revision guard" }] }],
      triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
    {
      id: "citation-requirement", name: "Citation requirement", type: "organisational", side: "preventive",
      health: "unverified", triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
    {
      id: "human-approval", name: "Human approval", type: "human", side: "preventive",
      health: "unverified", triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
    {
      id: "tool-call-policy", name: "Tool-call policy: block system-of-record targets (Tier 1)", type: "technical", side: "preventive",
      health: "unverified", triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
    {
      id: "output-dlp", name: "Output DLP", type: "technical", side: "mitigative",
      health: "unverified", triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
    {
      id: "approver-review", name: "Approver review", type: "human", side: "mitigative",
      health: "unverified", triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
    {
      id: "incident-playbook-key-rotation", name: "Incident playbook & key rotation", type: "organisational", side: "mitigative",
      health: "unverified", triad: { effective: { pass: true }, independent: { pass: true }, auditable: { pass: true } },
    },
  ],
};

const bowties: BowtieView[] = [
  toBowtieView(bowtieASeed as RawBowtieSeed, "A", "Pipeline integrity · DL-01"),
  toBowtieView(bowtieCSeed, "C", "Gen AI Safety · UC-1"),
  toBowtieView(bowtieDSeed as RawBowtieSeed, "D", "Urban flood · Bangkok"),
];

export function listBowties(): BowtieView[] {
  return bowties;
}

export function getBowtie(id: string): BowtieView | undefined {
  return bowties.find((bowtie) => bowtie.id === id);
}

function toBowtieView(seed: RawBowtieSeed, code: BowtieCode, title: string): BowtieView {
  return {
    id: seed.id,
    code,
    title,
    domain: seed.domain,
    hazard: seed.hazard,
    topEvent: seed.topEvent,
    provenance: seed.metadata?.label ?? (seed.metadata?.simulated ? "SIMULATION" : "SYNTHETIC"),
    classification: seed.metadata?.classification ?? "Not recorded",
    threats: (seed.threats ?? []).map(({ id, name }) => ({ id, name })),
    consequences: (seed.consequences ?? []).map(({ id, name }) => ({ id, name })),
    barriers: (seed.barriers ?? []).map((barrier) => ({
      id: barrier.id,
      name: barrier.name,
      type: barrier.type,
      side: barrier.side === "mitigative" ? "mitigative" : "preventive",
      health: isBarrierHealth(barrier.health) ? barrier.health : "unverified",
      degradationFactors: (barrier.degradationFactors ?? []).map((factor) => ({
        id: factor.id,
        description: factor.description,
        controls: (factor.controls ?? []).map(({ description }) => description),
      })),
      triad: Object.fromEntries(
        (["effective", "independent", "auditable"] as const)
          .filter((dimension) => barrier.triad?.[dimension])
          .map((dimension) => {
            const value = barrier.triad?.[dimension];
            return [dimension, { pass: value?.pass ?? false, justification: value?.justification }];
          }),
      ),
    })),
    independenceGroups: (seed.independenceGroups ?? []).map((group) => ({
      id: group.id,
      cause: group.cause,
      barrierIds: group.barrierIds ?? [],
    })),
  };
}

function isBarrierHealth(value: string | undefined): value is BarrierHealth {
  return value === "healthy" || value === "degraded" || value === "failed" || value === "unverified";
}
