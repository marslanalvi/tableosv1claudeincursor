import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { shellApi } from "../../lib/api-areas/shell.ts";
import { toast } from "../../app/toast.tsx";
import { isTypingTarget } from "../../app/ui.tsx";
import { undoStateKey } from "./BaseSessionProvider.tsx";

/**
 * Per-user undo/redo for a base: buttons state, mutations, toasts, and
 * Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, Ctrl+Y (ignored while typing in an input).
 */
export function useUndoRedo(baseId: string) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: undoStateKey(baseId),
    queryFn: () => shellApi.undoState(baseId),
    staleTime: 2_000,
  });

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ["bases", baseId] });
    void qc.invalidateQueries({ queryKey: ["views", baseId] });
    void qc.invalidateQueries({ queryKey: ["records", baseId] });
    void qc.invalidateQueries({ queryKey: ["record", baseId] });
    void qc.invalidateQueries({ queryKey: ["trash", baseId] });
    void qc.invalidateQueries({ queryKey: undoStateKey(baseId) });
  };

  const redoRef = useRef<() => void>(() => undefined);
  const undoRef = useRef<() => void>(() => undefined);

  const undo = useMutation({
    mutationFn: () => shellApi.undo(baseId),
    onSuccess: (res) => {
      refreshAll();
      toast.success(`Undid ${res.description}`, {
        action: { label: "Redo", onClick: () => redoRef.current() },
      });
    },
    onError: (err) => {
      if (err instanceof ApiProblemError && err.problem.code === ("NOTHING_TO_UNDO" as never)) {
        toast.info("Nothing to undo");
        void qc.invalidateQueries({ queryKey: undoStateKey(baseId) });
        return;
      }
      toast.error(err, "Undo failed");
    },
  });

  const redo = useMutation({
    mutationFn: () => shellApi.redo(baseId),
    onSuccess: (res) => {
      refreshAll();
      toast.success(`Redid ${res.description}`, {
        action: { label: "Undo", onClick: () => undoRef.current() },
      });
    },
    onError: (err) => {
      if (err instanceof ApiProblemError && err.problem.code === ("NOTHING_TO_REDO" as never)) {
        toast.info("Nothing to redo");
        void qc.invalidateQueries({ queryKey: undoStateKey(baseId) });
        return;
      }
      toast.error(err, "Redo failed");
    },
  });

  const busy = undo.isPending || redo.isPending;
  undoRef.current = () => {
    if (!busy) undo.mutate();
  };
  redoRef.current = () => {
    if (!busy) redo.mutate();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // Leave shortcuts alone while a modal dialog is open.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undoRef.current();
      } else if ((key === "z" && e.shiftKey) || (key === "y" && e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        redoRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return {
    canUndo: state.data?.canUndo ?? true,
    canRedo: state.data?.canRedo ?? false,
    undoLabel: state.data?.undoLabel ?? null,
    redoLabel: state.data?.redoLabel ?? null,
    busy,
    undo: () => undoRef.current(),
    redo: () => redoRef.current(),
  };
}
