import styles from "./views.module.css";

export function statusProps(q: {
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => unknown;
}) {
  return {
    isLoading: q.isLoading,
    isError: q.isError,
    isFetching: q.isFetching,
    onRetry: () => void q.refetch(),
  };
}

/** Loading / failed-to-load line shown above a non-grid view's records. */
export function RecordsStatus({
  isLoading,
  isError,
  isFetching,
  onRetry,
}: {
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  onRetry: () => void;
}) {
  if (isError) {
    return (
      <div className={styles.loadError} role="alert">
        <span>Couldn’t load records.</span>
        <button type="button" className={styles.linkBtn} disabled={isFetching} onClick={onRetry}>
          {isFetching ? "Retrying…" : "Retry"}
        </button>
      </div>
    );
  }
  return isLoading ? <div className={styles.loading}>Loading records…</div> : null;
}
