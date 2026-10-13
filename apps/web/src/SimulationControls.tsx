import { Select } from "@fieldloop/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, SessionError, type CurrentUser } from "./api-client";
import { applySimulationEvent, simulationKey } from "./simulation-events";
import { useSimulation, useSimulationEvents } from "./useSimulation";
import { useSimulationDraft } from "./simulation-draft";
import type { components } from "@fieldloop/contracts";

type Command = "play" | "pause" | "step" | "speed" | "bookmark" | "reset";
const commandPaths = {
  play: "/v1/simulation/runs/{runId}:play", pause: "/v1/simulation/runs/{runId}:pause",
  step: "/v1/simulation/runs/{runId}:step", speed: "/v1/simulation/runs/{runId}:speed",
  bookmark: "/v1/simulation/runs/{runId}:bookmark", reset: "/v1/simulation/runs/{runId}:reset",
} as const;

export function SimulationControls({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const current = useSimulation();
  const connected = useSimulationEvents();
  const run = current.data;
  const canControl = user.roles.some((role) => role === "fieldloop.operator" || role === "fieldloop.manager");
  const draft = useSimulationDraft();
  const catalog = useQuery({ queryKey: ["simulation", "scenarios"], queryFn: async ({ signal }) => {
    const { data, response } = await api.GET("/v1/scenarios", { signal });
    if (!response.ok || !data) throw new SessionError(response.status);
    return data;
  }, retry: false, enabled: canControl });
  const command = useMutation({ mutationFn: async ({ name, body = {} }: { name: Command; body?: components["schemas"]["PlayerCommand"] }) => {
    if (!run) throw new Error("SimulationRun is unavailable");
    const { data, response } = await api.POST(commandPaths[name], {
      body, params: { path: { runId: run.id }, header: { "X-CSRF-Token": user.csrfToken, "Idempotency-Key": crypto.randomUUID() } },
    });
    if (!response.ok || !data) throw new SessionError(response.status);
    return { data, name };
  }, onSuccess: async ({ data, name }) => {
    await applySimulationEvent(client, name === "reset" ? "simulation.reset" : "simulation.state", data);
    await client.invalidateQueries({ queryKey: simulationKey });
  } });
  const create = useMutation({ mutationFn: async () => {
    const seed = Number(draft.seed);
    if (!draft.seed.trim() || !Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw new Error("Invalid seed");
    const { data, response } = await api.POST("/v1/simulation/runs", {
      body: { scenarioId: draft.scenarioId, seed, speed: 1 },
      params: { header: { "X-CSRF-Token": user.csrfToken, "Idempotency-Key": crypto.randomUUID() } },
    });
    if (!response.ok || !data) throw new SessionError(response.status);
    return data;
  }, onSuccess: async (data) => { await applySimulationEvent(client, "simulation.state", data); } });
  const pending = command.isPending || create.isPending;
  const error = current.isError || catalog.isError || command.isError || create.isError;
  const paused = run?.state === "paused" || run?.state === "ready";

  return <section className="simulation-controls" aria-labelledby="simulation-title" aria-busy={pending}>
    <h2 id="simulation-title">{t("scenarioPlayer")}</h2>
    {current.isPending ? <p role="status">{t("simulationLoading")}</p> : null}
    {error ? <p id="simulation-error" role="alert">{t("simulationFailed")}</p> : null}
    {run ? <>
      <div className="simulation-status">
        <p role="status">{t(`simulationState.${run.state}`)} · {connected ? t("liveClock") : t("clockReconnecting")}</p>
        <time className="mono" dateTime={run.clock}>{run.clock}</time>
        <span className="mono">{run.elapsedSeconds.toFixed(1)} / {run.durationSeconds} s</span>
      </div>
      <progress aria-label={t("scenarioProgress")} value={run.elapsedSeconds} max={run.durationSeconds || 1} />
      {canControl ? <div className="simulation-actions">
        <button disabled={pending || !connected || run.state === "playing" || run.state === "finished"} onClick={() => command.mutate({ name: "play" })}>{t("play")}</button>
        <button disabled={pending || !connected || run.state !== "playing"} onClick={() => command.mutate({ name: "pause" })}>{t("pause")}</button>
        <button disabled={pending || !connected || !paused} onClick={() => command.mutate({ name: "step" })}>{t("step")}</button>
        <Select label={t("speed")} mono value={String(run.speed)} disabled={pending || !connected}
          options={[...new Set([1, 10, 60, 3600, run.speed])].map((speed) => ({ value: String(speed), label: `${speed}×` }))}
          onValueChange={(value) => command.mutate({ name: "speed", body: { speed: Number(value) } })} />
        <Select label={t("bookmark")} placeholder={t("chooseBookmark")} value={draft.bookmarkId}
          disabled={pending || !connected || !paused} options={run.bookmarks.map((bookmark) => ({
            value: bookmark.id, label: bookmark.name, disabled: bookmark.atSeconds < run.elapsedSeconds,
          }))} onValueChange={draft.selectBookmark} />
        <button disabled={pending || !connected || !paused || !draft.bookmarkId} onClick={() => command.mutate({ name: "bookmark", body: { bookmarkId: draft.bookmarkId } })}>{t("jumpBookmark")}</button>
        <button disabled={pending} onClick={() => command.mutate({ name: "reset" })}>{t("resetSimulation")}</button>
      </div> : <p>{t("simulationReadOnly")}</p>}
    </> : null}
    {canControl && (!run || (run.state === "ready" && run.nextEventIndex === 0)) ? <form className="simulation-setup" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
      {catalog.data?.length ? <>
        <Select label={t("scenario")} placeholder={t("chooseScenario")} value={draft.scenarioId}
          options={catalog.data.map((scenario) => ({ value: scenario.id, label: scenario.name }))}
          onValueChange={draft.selectScenario} disabled={pending} />
        <div className="simulation-field"><label htmlFor="simulation-seed">{t("seed")}</label><input id="simulation-seed" className="mono" type="number" min="0" max="2147483647" step="1" value={draft.seed} required disabled={pending} onChange={(event) => draft.setSeed(event.target.value)} aria-describedby={error ? "simulation-error" : undefined} /></div>
        <button type="submit" disabled={pending || !draft.scenarioId}>{pending ? t("simulationWorking") : t("createRun")}</button>
      </> : catalog.isPending ? <p role="status">{t("simulationLoading")}</p> : !catalog.isError ? <p>{t("noScenarios")}</p> : null}
    </form> : null}
  </section>;
}
