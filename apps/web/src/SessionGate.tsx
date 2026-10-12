import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getCurrentUser, loginDestination, SessionError, type CurrentUser } from "./api-client";

export function SessionGate({ children }: { children: (user: CurrentUser) => React.ReactNode }) {
  const { t } = useTranslation();
  const session = useQuery({
    queryKey: ["session"], queryFn: ({ signal }) => getCurrentUser(signal), retry: false,
    staleTime: 0, refetchInterval: 60_000, refetchOnWindowFocus: "always",
  });
  const signedOut = session.error instanceof SessionError && session.error.status === 401;
  useEffect(() => { if (signedOut) window.location.replace(loginDestination()); }, [signedOut]);

  if (signedOut) return <main className="session-status" role="status">{t("redirecting")}</main>;
  // A failed validation hides previously cached identity, including after revocation.
  if (session.isError) return <main className="session-status" id="main-content">
    <h1>{t("unavailable")}</h1><p role="alert">{t("unavailableDetail")}</p>
    <button disabled={session.isFetching} onClick={() => { void session.refetch(); }}>{t("retry")}</button>
  </main>;
  if (!session.data) return <main className="session-status" role="status">
    <p>{t("loading")}</p><div className="skeleton" aria-hidden="true" />
  </main>;
  return children(session.data);
}
