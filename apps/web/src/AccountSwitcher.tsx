import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { endSession, type CurrentUser } from "./api-client";

export function AccountSwitcher({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => endSession(user.csrfToken),
    onSuccess: (destination) => { queryClient.clear(); window.location.assign(destination); },
  });
  return <details className="account-switcher">
    <summary>{t("switchAccount")}</summary>
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
  </details>;
}
