import { isSimulationRun } from "@fieldloop/contracts/simulation";
import replay from "./bangkok-rain-replay.json" with { type: "json" };

// Python's test_rain_replay.py checks this committed replay against the authored
// Scenario and the real player. Validate its public contract in the web tests too.
export function rainSnapshot(name: string) {
  const snapshots: Record<string, unknown> = replay.snapshots;
  const run = snapshots[name];
  if (!isSimulationRun(run)) throw new Error(`Invalid real player snapshot: ${name}`);
  return run;
}
