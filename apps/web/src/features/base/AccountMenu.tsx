import { useRouter } from "@tanstack/react-router";
import { useMe, useLogout } from "../auth/use-auth.ts";
import { Avatar, DropdownMenu, uiStyles } from "../../app/ui.tsx";

/** Avatar button with account info and Log out (used in home + base headers). */
export function AccountMenu() {
  const me = useMe();
  const logout = useLogout();
  const router = useRouter();
  const name = me.data?.name || me.data?.email || "Account";
  return (
    <DropdownMenu
      align="right"
      trigger={({ toggle }) => (
        <button
          type="button"
          className={uiStyles.iconBtn}
          style={{ width: 32, height: 32, padding: 0 }}
          aria-label="Account menu"
          onClick={toggle}
        >
          <Avatar name={name} id={me.data?.id ?? name} />
        </button>
      )}
      items={[
        {
          key: "who",
          heading: true,
          label: (
            <span style={{ textTransform: "none", letterSpacing: 0 }}>
              <strong style={{ display: "block", fontWeight: 500, color: "var(--tabula-color-text)", fontSize: 14 }}>
                {me.data?.name || "Signed in"}
              </strong>
              {me.data?.email}
            </span>
          ),
        },
        {
          key: "account",
          label: "Account",
          icon: "☺",
          separatorBefore: true,
          onSelect: () => {
            void router.navigate({ to: "/account" });
          },
        },
        {
          key: "admin",
          label: "Members & access",
          icon: "⚿",
          onSelect: () => {
            void router.navigate({ to: "/admin", search: { tab: "people" } });
          },
        },
        {
          key: "help",
          label: "Help & documentation",
          icon: "?",
          onSelect: () => {
            void router.navigate({ to: "/help/$topic", params: { topic: "getting-started" } });
          },
        },
        {
          key: "home",
          label: "All workspaces",
          icon: "⌂",
          onSelect: () => {
            void router.navigate({ to: "/" });
          },
        },
        {
          key: "logout",
          label: logout.isPending ? "Logging out…" : "Log out",
          icon: "⎋",
          separatorBefore: true,
          onSelect: () => logout.mutate(),
        },
      ]}
    />
  );
}
