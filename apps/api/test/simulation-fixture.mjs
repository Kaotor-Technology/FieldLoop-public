// Scripted, local-only UI fixture; the real player is exercised by test-simulation.sh.
import { randomUUID } from "node:crypto";
let run = null;
let anchor = Date.now();
let revision = 0;
const responses = new Map();
const scenario = { id: "player-test", name: "Player verification fixture", version: "1", durationSeconds: 120, simulated: true, classification: "HIGHLY_RESTRICTED" };
function current() {
  if (run?.state === "playing") {
    const elapsed = Math.min(120, run.elapsedSeconds + (Date.now() - anchor) / 1000 * run.speed);
    run = { ...run, revision: ++revision, elapsedSeconds: elapsed, clock: new Date(Date.parse("2026-10-13T00:00:00Z") + elapsed * 1000).toISOString(), state: elapsed === 120 ? "finished" : "playing" };
  }
  anchor = Date.now();
  return run;
}
function ready(seed, speed) {
  return { id: randomUUID(), revision: ++revision, orgId: "synthetic-org", scenarioId: scenario.id, scenarioName: scenario.name, seed, speed, clock: "2026-10-13T00:00:00Z", elapsedSeconds: 0, durationSeconds: 120, state: "ready", nextEventIndex: 0, eventCount: 3, simulated: true, classification: scenario.classification, bookmarks: [{ id: "failure", name: "Failure", atSeconds: 60 }] };
}
export function resetSimulationFixture() { run = null; revision = 0; responses.clear(); }
export const simulator = {
  orgId: "synthetic-org", scenarios: async () => [scenario], current: async () => current(),
  read: async () => current(),
  create: async (body, key) => {
    if (responses.has(key)) return responses.get(key);
    run = ready(body.seed, body.speed); responses.set(key, run); return run;
  },
  command: async (_id, command, body, key) => {
    if (responses.has(key)) return responses.get(key);
    current();
    if (command === "reset") run = ready(run.seed, run.speed);
    else {
      run = { ...run, revision: ++revision };
      if (command === "play") run.state = "playing";
      if (command === "pause") run.state = "paused";
      if (command === "speed") run.speed = body.speed;
      if (command === "step" || command === "bookmark") {
        run.elapsedSeconds = command === "bookmark" ? 60 : run.nextEventIndex === 0 ? 0 : run.nextEventIndex === 1 ? 60 : 120;
        run.nextEventIndex = run.elapsedSeconds >= 60 ? 3 : 1;
        run.state = run.elapsedSeconds === 120 ? "finished" : "paused";
        run.clock = new Date(Date.parse("2026-10-13T00:00:00Z") + run.elapsedSeconds * 1000).toISOString();
      }
    }
    responses.set(key, run); return run;
  },
};
