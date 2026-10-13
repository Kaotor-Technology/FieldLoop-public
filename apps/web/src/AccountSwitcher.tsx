import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { endSession, type CurrentUser } from "./api-client";

export function AccountSwitcher({ user }: { user: CurrentUser }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => endSession(user.csrfToken),
    onSuccess: (destination) => { queryClient.clear(); window.location.assign(destination); },
  });
  return <details className="account-switcher">
    <summary>{user.persona}</summary>
    <div className="account-menu">
      <h2>{t("identity")}</h2>
      <dl>
        <dt>{t("persona")}</dt><dd lang="en">{user.persona}</dd>
        <dt>{t("roles")}</dt><dd className="mono">{user.roles.join(", ")}</dd>
        <dt>{t("subject")}</dt><dd className="mono">{user.sub}</dd>
        <dt>{t("authTime")}</dt><dd className="mono"><time dateTime={user.authTime}>{new Date(user.authTime).toLocaleString(i18n.language === "th" ? "th-TH" : "en-GB", { timeZone: "Asia/Bangkok" })}</time></dd>
      </dl>
      <p>{t("switchDetail")}</p>
      <ul className="role-list">
        {(["viewer", "operator", "manager"] as const).map((role) => <li key={role}>
          <strong>{t(role)}</strong><span>{t(`${role}Detail`)}</span>
        </li>)}
      </ul>
      {logout.isError && <p role="alert">{t("logoutFailed")}</p>}
      <button disabled={logout.isPending} onClick={() => logout.mutate()}>
        {t(logout.isPending ? "signingOut" : "confirmSwitch")}
      </button>
    </div>
  </details>;
}
