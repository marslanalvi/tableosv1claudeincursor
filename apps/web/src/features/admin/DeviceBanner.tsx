import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { adminApi } from "../../lib/api-areas/admin.ts";
import { api } from "../../lib/api.ts";
import { authQueryKey } from "../auth/use-auth.ts";
import styles from "./admin.module.css";

/** Tells a signed-in member why some workspaces are hidden: this device isn't approved yet. */
export function DeviceBanner() {
  const me = useQuery({ queryKey: authQueryKey, queryFn: () => api.me(), enabled: false });
  const pending = useQuery({
    queryKey: ["devices", "current"],
    queryFn: () => adminApi.currentDevice(),
    enabled: Boolean(me.data),
    refetchInterval: 30_000,
    retry: false,
  });
  const [hidden, setHidden] = useState(false);
  const list = pending.data?.pending ?? [];
  const qc = useQueryClient();
  const prev = useRef(0);
  useEffect(() => {
    // Approved meanwhile: reload everything that was hidden.
    if (prev.current > list.length) void qc.invalidateQueries();
    prev.current = list.length;
  }, [list.length, qc]);
  if (hidden || list.length === 0) return null;
  return (
    <div className={styles.banner} role="status">
      <div>
        {list.map((p) => (
          <div key={p.orgId}>
            {p.status === "revoked" ? (
              <>
                <strong>This device was blocked</strong> for {p.orgName}. Ask {p.ownerName ?? "the owner"} to approve it again.
              </>
            ) : (
              <>
                <strong>Waiting for approval.</strong> {p.ownerName ?? "The owner"} needs to approve this device ({p.label}) before you can open {p.orgName}. This page updates on its own.
              </>
            )}
          </div>
        ))}
      </div>
      <button type="button" className={styles.bannerClose} aria-label="Dismiss" onClick={() => setHidden(true)}>
        ✕
      </button>
    </div>
  );
}
