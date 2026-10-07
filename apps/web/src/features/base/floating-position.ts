export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end" | "right-start";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FloatingPosition {
  left: number;
  top: number;
  maxHeight: number;
}

const MARGIN = 8;

/**
 * Place a panel next to its anchor so it stays fully inside the viewport:
 * flip to the opposite side when the preferred one is too small, shift along
 * the cross axis, and cap the height to the space that is left.
 */
export function computeFloatingPosition(
  anchor: Rect,
  panel: { width: number; height: number },
  placement: Placement,
  viewport: { width: number; height: number },
  gap = 4,
): FloatingPosition {
  const maxLeft = Math.max(MARGIN, viewport.width - MARGIN - panel.width);
  const clampLeft = (x: number) => Math.min(Math.max(MARGIN, x), maxLeft);

  if (placement === "right-start") {
    let left = anchor.right + gap;
    if (left + panel.width > viewport.width - MARGIN) left = anchor.left - gap - panel.width;
    const maxHeight = viewport.height - 2 * MARGIN;
    const height = Math.min(panel.height, maxHeight);
    const top = Math.min(Math.max(MARGIN, anchor.top), viewport.height - MARGIN - height);
    return { left: clampLeft(left), top, maxHeight };
  }

  const above = anchor.top - gap - MARGIN;
  const below = viewport.height - anchor.bottom - gap - MARGIN;
  let side: "top" | "bottom" = placement.startsWith("top") ? "top" : "bottom";
  const preferred = side === "top" ? above : below;
  const other = side === "top" ? below : above;
  if (preferred < panel.height && other > preferred) side = side === "top" ? "bottom" : "top";
  const maxHeight = Math.max(80, side === "top" ? above : below);
  const height = Math.min(panel.height, maxHeight);
  const top = side === "top" ? anchor.top - gap - height : anchor.bottom + gap;
  const left = placement.endsWith("end") ? anchor.right - panel.width : anchor.left;
  return { left: clampLeft(left), top: Math.max(MARGIN, top), maxHeight };
}
