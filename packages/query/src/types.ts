import type { CompileFilterOptions, SqlFieldInfo, SqlKeyType } from "@tabula/filter";

export type SortDirection = "asc" | "desc";

export interface SortSpec {
  /** Field id (`fld_…` or uuid) or `manualOrder` for the table's manual order. */
  fieldId: string;
  direction: SortDirection;
}

export interface RecordQueryInput {
  filter?: unknown;
  /** Additional filter ANDed with `filter` (e.g. a view's saved filter). */
  viewFilter?: unknown;
  sort?: SortSpec[] | undefined;
  search?: string | undefined;
  pageSize: number;
  cursor?: string | null | undefined;
}

export interface PlanQueryContext extends CompileFilterOptions {
  /** Field metadata keyed by every accepted id spelling. */
  fields: Map<string, SqlFieldInfo>;
  /** Fields searched by `search` (default: all distinct fields). */
  searchFields?: SqlFieldInfo[] | undefined;
}

export interface SortKeyPlan {
  /** Sort spec this key came from (`manualOrder` for the implicit tiebreaker). */
  fieldId: string;
  expr: string;
  type: SqlKeyType;
  direction: SortDirection;
}

export interface RecordQueryPlan {
  pageSize: number;
  limit: number;
  keys: SortKeyPlan[];
  idDirection: SortDirection;
  /** WHERE predicate (without table scope / deleted filter); "TRUE" when none. */
  whereSql: string;
  /** Shared params (placeholders in `whereSql` and key exprs refer into it). */
  params: unknown[];
  /** Number of leading params referenced by `whereSql` (for count queries). */
  whereParamCount: number;
  signature: string;
  cursor?: DecodedCursor | undefined;
}

export interface DecodedCursor {
  keys: (string | null)[];
  id: string;
}

/** Legacy cursor shapes (still decodable). */
export interface ManualOrderCursor {
  kind: "manualOrder";
  manualOrder: string;
  id: string;
}
