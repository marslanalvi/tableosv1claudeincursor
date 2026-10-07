# Fix pass — shared contracts and working rules

Seven workstreams (A–G) run **in parallel in the same working tree**. This file is the source of truth for anything that crosses a workstream boundary. If you need to change a contract here, keep the change backward compatible and note it at the bottom under "Contract changes".

Audit reports that motivated this pass live in `docs/fix-plan/audit-*.md`.

---

## 1. Working rules (every workstream)

1. **Only edit files you own** (ownership table in §9). If you must touch a file owned by someone else, keep the edit tiny, re-read the file immediately before editing, and touch only the region named in §9 "shared regions".
2. **Packages are consumed from `dist/`.** After changing `packages/<name>/src`, run `npx pnpm@9.15.0 --filter @tabula/<name> build`. Never run the root `pnpm build`/`pnpm typecheck` (other workstreams are mid-edit).
3. Typecheck only what you touch:
   - server: `npx tsc -p apps/server/tsconfig.json --noEmit`
   - web: `npx tsc -p apps/web/tsconfig.app.json --noEmit`
   - public: `npx tsc -p apps/public/tsconfig.app.json --noEmit`
   - a package: `npx tsc -p packages/<name>/tsconfig.json --noEmit`
   Errors in files you don't own may be another workstream mid-edit: ignore those, never "fix" them.
4. **Running stack (already up, hot-reloading; do not start/stop servers):**
   API `http://localhost:3200` · realtime `ws://localhost:3202` · web `http://localhost:5283` (proxies `/v1` and `/ws`) · public `http://localhost:5284`. Worker + relay also run. Logs: `.data/logs/<role>.log`. (Started detached via `scripts/dev-isolated.ps1`; stop with `scripts/dev-isolated-stop.ps1` — only the orchestrator restarts the stack.)
   DB: `postgres://tabula:tabula@localhost:5432/tabula_cc` (docker container `docker-postgres-1`, `docker exec docker-postgres-1 psql -U tabula -d tabula_cc`). Redis DB 1.
   Apply new migrations with: `DATABASE_URL=postgres://tabula:tabula@localhost:5432/tabula_cc npx pnpm@9.15.0 db:migrate`.
   **Never touch the `tabula` database or ports 3000/3002/5173/3100/3102/5183/5184** — those belong to OTHER checkouts (`32TableOS`, `32TableOSCursor`). Never kill processes you didn't start.
5. **Testing:** verify with real HTTP calls against `http://localhost:3200` (curl / node fetch with a cookie jar). Create your own test user: `POST /v1/auth/signup {email, password, name}` with an email like `ws-<letter>-<n>@tabula.test`. UI workstreams may use the browser pane **only in a tab they create** (`tabs_create`), never the existing tabs.
6. **Migrations:** new files only, numbered from your reserved range (§9). Never edit an existing migration.
7. **Line endings:** files are LF. If you script edits in Python on Windows, open with `newline=""`.
8. **Do not commit.** The orchestrator commits per workstream after review.
9. Add tests next to code you change where a test runner exists (`node --import tsx --test`), especially for pure logic (filter compiler, formula, conversion, order keys).
10. When done, report: what you fixed, what you verified and how, what is still missing, and any contract changes.

---

## 2. Identifiers

- API speaks **public ids only**: `bas_ tbl_ fld_ rec_ viw_ usr_ wsp_ att_ cmt_ aut_ shr_ opt_`. Server converts with `pid()` / `parsePid()` (`apps/server/src/lib/public-ids.ts`). `parsePid` throws `PublicIdError` → 422.
- Select options: `{ id: "opt_<random>", label: string, color: string }`. **Cells store option ids, never labels.**
- Fractional order keys compare with `COLLATE "C"` (migration 0011). Use `keyBetween(a, b)` from `@tabula/types` (workstream B adds it; until then `nextOrderKey()`).

## 3. Record wire format (all record-returning endpoints)

```jsonc
{
  "id": "rec_…",
  "version": 7,                       // bumps on every cell write
  "createdAt": "ISO", "updatedAt": "ISO",
  "rowNumber": 12, "manualOrder": "a…",
  "fields": { "fld_…": <value>, … }    // keyed by public field id; empty values are OMITTED
}
```

Value shapes by field type (output; input accepts the same shape, or the "input shorthand"):

| type | output value | input shorthand |
|---|---|---|
| `text`, `long_text`, `email`, `url`, `phone` | string | |
| `number`, `percent`, `rating`, `duration` (seconds) | number | numeric string |
| `currency` | number | numeric string |
| `checkbox` | `true` (absent = false) | `false` clears |
| `date` | `"YYYY-MM-DD"` | |
| `datetime` | ISO-8601 UTC string | |
| `single_select` | `"opt_…"` | option label (typecast) |
| `multi_select` | `["opt_…", …]` | labels (typecast) |
| `collaborator` | `[{ "id":"usr_…", "name", "email" }]` (array even if single) | `["usr_…"]` or `"usr_…"` |
| `attachment` | `[{ "id":"att_…", "filename", "mime", "size", "url", "thumbnailUrl"|null, "width"|null, "height"|null }]` | `["att_…"]` |
| `link` | `[{ "id":"rec_…", "name": "<primary display>" }]` | `["rec_…"]` |
| `lookup` | array of the target field's output values | read-only |
| `rollup`, `count`, `formula` | scalar result (number/string/bool/date) — **never** `{value,status}` | read-only |
| `autonumber` | number (= rowNumber) | read-only |
| `created_time`, `modified_time` | ISO string | read-only |
| `created_by`, `modified_by` | `{ "id":"usr_…", "name", "email" }` | read-only |
| `barcode` | `{ "text": string }` | string |
| `button` | not returned (config only) | read-only |
| `json` | any JSON | |

Formula errors: value omitted; record carries `"errors": { "fld_…": "#ERROR message" }` (optional key).

### Record endpoints (workstream B owns writes, A owns reads)
- `POST /v1/bases/:b/tables/:t/records` `{fields, typecast?}` → `201 {record: Record}`
- `POST …/records/batch` `{records:[{fields}], typecast?}` (1–500) → `201 {records: Record[]}`
- `PATCH …/records/:r` `{fields, typecast?, version?}` (or `If-Match`) → `200 {record: Record}` **with new version and full fields**
- `PATCH …/records/batch` `{records:[{id, fields}], typecast?}` → `200 {records: Record[]}` (bulk paste/fill)
- `DELETE …/records/:r` → 204; `POST …/records/batch-delete` `{ids:[]}` → 204
- `POST …/records/:r/duplicate` → `201 {record}`
- `POST …/records/:r/move` `{before?: "rec_…"|null, after?: "rec_…"|null}` → `200 {record}` (manual reorder)
- `POST …/records/query` (A) → `{records: Record[], nextCursor, totalCount?}`
  body: `{ filter?, sort?: [{field, direction}], search?: string, viewId?, pageSize? (≤500), cursor?, fields?: ["fld_…"] }`
  When `viewId` is given, the view's saved filter is ANDed with `filter` and its sorts are used unless `sort` is provided.
- `GET …/records/:r` (A) → `{record}`
- `POST …/records/group` (A) → `{groups:[{key, value, count, aggregates}]}`

## 4. Field metadata

`FieldDto = { id:"fld_…", name, type, slot, config, description: string|null, isPrimary: boolean, isComputed: boolean }`
returned by `GET /v1/bases/:b` (in `tables[].fields`), `GET …/fields`, and every field mutation.

Config per type (B owns the schema in `packages/fields`):
- `single_select` / `multi_select`: `{ options: [{id, label, color}] }`
- `number`: `{ precision: 0-8 }` · `currency`: `{ symbol: "$", precision }` · `percent`: `{ precision }`
- `rating`: `{ max: 1-10, icon: "star"|"heart"|"check" }` · `duration`: `{ format: "h:mm"|"h:mm:ss" }`
- `date`: `{ format: "local"|"iso"|"us"|"eu" }` · `datetime`: `{ format, timeFormat: "12h"|"24h", timeZone?: string }`
- `link`: `{ linkedTableId:"tbl_…", inverseFieldId:"fld_…"|null, allowMultiple: boolean }`
- `lookup`: `{ linkFieldId:"fld_…", targetFieldId:"fld_…" }`
- `rollup`: `{ linkFieldId, targetFieldId, aggregation: "sum"|"avg"|"min"|"max"|"count"|"counta"|"countall"|"concat"|"and"|"or"|"unique" }`
- `count`: `{ linkFieldId }`
- `formula`: `{ expression: string /* {Field Name} refs, stored with field ids internally */, resultType?: "number"|"text"|"date"|"boolean" }`
- `collaborator`: `{ allowMultiple: boolean, notify?: boolean }` · `attachment`: `{}` · `barcode`: `{}`
- `button`: `{ label, style?, action: { type: "open_url", url: string } | { type: "run_automation", automationId } }`

Field endpoints (B):
- `POST …/fields` `{name, type, config?, description?}` → `201 {field: FieldDto}` (link type creates the relation + inverse field; computed types are backfilled)
- `PATCH …/fields/:f` `{name?, description?, config?, type?}` → `200 {field}` — `type` change converts existing values (long op if large)
- `DELETE …/fields/:f` → 204 (409 `PRIMARY_FIELD_REQUIRED` for primary)
- `POST …/fields/:f/duplicate` `{withValues: boolean}` → `201 {field}`
- `POST …/fields/reorder` `{fieldIds: [...]}` → 204 (table-level default order)
- `POST /v1/bases/:b/tables/:t/primary-field` `{fieldId}` → 200
Tables (F owns UI, B owns server): `PATCH …/tables/:t {name}`, `DELETE …/tables/:t`, `POST …/tables/:t/duplicate {withRecords}`, `POST /v1/bases/:b/tables/reorder {tableIds}`.

## 5. View config (`views.config` JSONB) — D owns

```ts
interface ViewConfig {
  filter: FilterAst | null;                     // §6
  sorts: { fieldId: string; direction: "asc" | "desc" }[];
  groups: { fieldId: string; direction: "asc" | "desc" }[];   // ≤ 3
  hiddenFieldIds: string[];
  fieldOrder: string[];                          // fld_ ids; fields not listed append at end
  fieldWidths: Record<string, number>;           // px
  frozenFieldCount: number;                      // default 1 (primary)
  rowHeight: "short" | "medium" | "tall" | "extra";
  color: { mode: "none" } | { mode: "select"; fieldId: string } |
         { mode: "conditions"; rules: { filter: FilterAst; color: string }[] };
  summary: Record<string, "none"|"count"|"empty"|"filled"|"unique"|"sum"|"avg"|"min"|"max">;
  kanban?:   { stackFieldId: string | null; coverFieldId?: string | null; hideEmptyStacks?: boolean };
  calendar?: { dateFieldId: string | null; endDateFieldId?: string | null };
  gallery?:  { coverFieldId?: string | null; coverFit?: "cover" | "contain" };
  timeline?: { startFieldId: string | null; endFieldId?: string | null; scale?: "day"|"week"|"month" };
  form?: { title: string; description: string; fields: { fieldId: string; required: boolean; label?: string; help?: string }[];
           submitLabel: string; successMessage: string; allowResubmit: boolean };
}
```
- `GET /v1/bases/:b` and `GET …/views` return `config` (defaults filled in) for every view.
- `PATCH …/views/:v` `{ name?, config?: Partial<ViewConfig> (shallow merge), visibility? }` → `200 {view}`
- `DELETE …/views/:v` → 204 · `POST …/views/:v/duplicate` → `201 {view}` · `POST …/views/reorder {viewIds}` → 204
- View types: `grid | kanban | calendar | gallery | timeline | list | form | gantt` (gantt = timeline with dependencies).

## 6. Filter AST — A owns (`packages/filter`)

Existing shape stays: `{kind:"and"|"or", children}` | `{kind:"condition", fieldId, op, value?}`. `fieldId` may be `fld_…` or raw uuid.
Operators (A implements all, SQL + in-memory evaluator):
`eq neq contains notContains startsWith endsWith gt gte lt lte empty notEmpty anyOf noneOf hasAnyOf hasAllOf isWithin isBefore isAfter isOnOrBefore isOnOrAfter isMe`
- dates: `value` may be `"YYYY-MM-DD"` or `{ relative: "today"|"tomorrow"|"yesterday"|"oneWeekAgo"|"oneWeekFromNow"|"oneMonthAgo"|"oneMonthFromNow"|"exactDate", date?: "YYYY-MM-DD" }`; `isWithin` value `{ range: "pastWeek"|"pastMonth"|"pastYear"|"nextWeek"|"nextMonth"|"nextYear"|"thisWeek"|"thisMonth"|"pastNDays"|"nextNDays", n?: number }`
- select: `eq/neq` take an option id; `anyOf/noneOf` take option id arrays; multi-select uses `hasAnyOf/hasAllOf/noneOf`.
- Operators valid per type are exported as `operatorsForFieldType(type): FilterOp[]` with labels from `operatorLabel(op)` — UI must use these (no hard-coded lists).

## 7. Web conventions — React Query keys

| Key | Data |
|---|---|
| `["bases", baseId]` | `BaseDetail` (tables, fields, views incl. config) |
| `["records", baseId, tableId, ...rest]` | record pages; **invalidate with prefix `["records", baseId, tableId]`** |
| `["record", baseId, tableId, recordId]` | single record (drawer) |
| `["views", baseId, tableId]` | views list |
| `["comments", baseId, tableId, recordId]`, `["attachments", …]` | drawer |
| `["automations", baseId]`, `["notifications"]`, `["workspaces"]`, `["workspaces", wsId, "bases"]` | |

Realtime (F): on a `change` frame for a table → `invalidateQueries(["records", baseId, tableId])` (and `["record", …]` for touched ids); schema/view changes → `["bases", baseId]`. Own edits (matching `clientMutationId`) are skipped.

API client: add new functions in `apps/web/src/lib/api-areas/<area>.ts` using `import { request } from "../api"`. Fix existing functions in `api.ts` only within your area (§9).

## 8. Grid component contract (C implements, D wires)

```ts
interface GridViewProps {
  baseId: string; table: TableDto; view: ViewDto;   // view.config: ViewConfig
  filter: FilterAst | null;       // effective (saved + ad-hoc)
  sorts: ViewConfig["sorts"]; groups: ViewConfig["groups"];
  search: string;
  hiddenFieldIds: string[]; fieldOrder: string[]; fieldWidths: Record<string, number>;
  frozenFieldCount: number; rowHeight: ViewConfig["rowHeight"]; color: ViewConfig["color"];
  summary: ViewConfig["summary"];
  canEdit: boolean;
  onConfigChange(patch: Partial<ViewConfig>): void;   // column resize/reorder/hide/sort-from-header etc.
  onOpenRecord(recordId: string): void;
}
```
`apps/web/src/features/grid/GridView.tsx` exports `GridView`. `apps/web/src/features/record/RecordDrawer.tsx` exports `RecordDrawer({baseId, tableId, recordId, onClose, onNavigate?})` (C). Other view types (D) call `onOpenRecord` → drawer.

Field UI (C, `packages/field-ui`): `renderCellValue(field, value)`, `<FieldValueEditor field value onChange />`, `fieldTypeIcon(type)`, `fieldTypeLabel(type)`, `<FieldConfigEditor type config onChange fields tables />` — D/E reuse these in kanban/gallery/forms/public app.

## 9. Ownership

| WS | Scope | Owns (edit freely) | Migration range |
|---|---|---|---|
| **A** | Query & filter engine, record read path | `packages/filter`, `packages/query`, `apps/server/src/modules/query/**`, `apps/server/src/modules/recordstore/**` (sidecars), record read serialization helper `apps/server/src/modules/records/serialize.ts` (new, shared by B) | 0020–0029 |
| **B** | Schema, fields, compute, formula, links, record writes, tables server | `packages/fields`, `packages/compute`, `packages/formula`, `packages/links`, `packages/types` (order keys only), `apps/server/src/modules/{schema,compute,links,records}/**` (except `records/serialize.ts` read-only use), `apps/server/src/modules/base/bootstrap-default-table.ts` | 0030–0039 |
| **C** | Grid, cells, field UI, record drawer, field header/row menus | `apps/web/src/features/{grid,schema,record}/**`, `packages/field-ui`, `packages/grid`, `apps/web/src/lib/api-areas/records.ts`, `…/fields.ts` | — |
| **D** | Views: toolbar, sidebar, all view types, forms builder, views server | `apps/web/src/features/views/**`, `apps/web/src/routes/table-grid.tsx`, `apps/server/src/modules/views/**`, `apps/web/src/lib/api-areas/views.ts` | 0040–0049 |
| **E** | Sharing + public app, attachments, import/export, search, notifications, contacts, comments | `apps/web/src/features/{share,import,search,notifications}/**`, `apps/web/src/routes/contacts.tsx`, `apps/public/**`, `apps/server/src/modules/{share,attachments,import-export,search,notifications,contacts,comments,wave4,collab}/**`, `packages/storage`, `packages/search`, `apps/web/src/lib/api-areas/{share,files,search,collab}.ts` | 0050–0059 |
| **F** | Realtime, events/jobs infra, base shell, home, auth UI, undo/redo, tables UI | `apps/server/src/entrypoints/**`, `apps/server/src/kernel/**`, `apps/server/src/modules/{history,base,workspace,organization}/**` (except `base/bootstrap-default-table.ts`), `packages/{events,jobs,realtime-protocol,realtime-client,record-store}`, `apps/web/src/features/{base,tools}/**`, `apps/web/src/routes/{base,index,__root,login,signup}.tsx` and other non-listed routes, `apps/web/src/app/**`, `apps/web/src/lib/api-areas/shell.ts` | 0060–0069 |
| **G** | Automations (engine + UI), auth/security server, invitations, audit, billing, idempotency, error mapping, permissions | `apps/web/src/features/automations/**`, `apps/server/src/modules/{automations,auth,invitations,audit,billing,feature-flags,access}/**`, `apps/server/src/http/**`, `packages/permissions`, `packages/auth`, `packages/db/migrations` 0012–0019 | 0012–0019 |

**Shared regions** (re-read immediately before editing, minimal diff):
- `apps/web/src/lib/api.ts` — each WS may edit only functions for its area (A/B: records & fields & query; C: none, use api-areas; D: views; E: share/attachments/import/search/notifications/contacts/comments; F: auth/workspaces/bases/tables/undo; G: automations).
- `apps/web/src/routes/base.tsx` — F owns; D may edit only the "create view" handler block.
- `apps/server/src/http/app.ts` route registration — G owns; others add one `register…` line if they add a new routes file.
- `packages/db/src` Kysely types — anyone adding a migration may add matching types.

**Permissions (G, phase 2):** G adds `compileForUser` + `assertCan` checks across all route files **after** the other workstreams finish. In phase 1, other workstreams should already call `assertCan(snapshot, "<action>")` in new handlers they write (`apps/server/src/modules/access/assert.ts`).

---

## 10. Cross-workstream hand-offs

| Provider | Deliverable | Consumer |
|---|---|---|
| A (first task) | `apps/server/src/modules/records/serialize.ts`: `serializeRecords(db, tableId, rows, opts?) → Promise<RecordWire[]>` implementing §3 (computed unwrap, meta fields, collaborator/link/attachment hydration) | B (write responses), E (public share records), D |
| A | `packages/filter`: `operatorsForFieldType`, `operatorLabel`, `evaluateFilter(ast, record, fields, ctx)` | C, D, G (automation conditions) |
| B | **Links are authoritative in `data.record_links`.** Cells no longer hold link arrays (B migrates/ignores legacy link cells). A's serializer reads links from `record_links`. | A |
| B (early) | `keyBetween(a: string|null, b: string|null): string` exported from `@tabula/types` | B, D (view reorder), F (table reorder) |
| F (first task) | `kernel/mutation.ts`: `mctx.afterCommit(fn: () => Promise<void> | void)`; realtime publish moved after commit | B (compute job enqueue), E, G |
| F | `GET /v1/bases/:b/collaborators` → `{ collaborators: [{id:"usr_…", name, email, role}] }` | C (collaborator picker), E (mentions), G |
| E | `apps/web/src/lib/api-areas/files.ts`: `uploadAttachment(baseId, file, onProgress?) → Promise<AttachmentWire>` (presign → PUT → complete); `GET /v1/bases/:b/attachments/:id` returns fresh signed URL | C (attachment cell + drawer) |
| E | `apps/web/src/features/comments/RecordComments.tsx` `({baseId, tableId, recordId})` — list/post/edit/delete/react, @mentions | C mounts it in the drawer |
| E | `apps/web/src/features/import/ImportWizard.tsx` `({baseId, tableId?, onClose})` and `ExportMenu` `({baseId, tableId, viewId})` | F (Tools menu / table tab menu) |
| C | `apps/web/src/features/schema/FieldManager.tsx` `({baseId, table, onClose})` | F (Tools → Manage fields) |
| D | `apps/web/src/features/views/FormsIndex.tsx` `({baseId})` | F (base "Forms" tab) |
| D | may edit the views-serialization block of `getBase` in `apps/server/src/modules/base/routes.ts` (shared region) | — |

Interfaces (Airtable "Interfaces" designer) are **out of scope for this pass**; F replaces the placeholder with a clear "coming soon" empty state.

## Contract changes

- 2026-10-06 (orchestrator): stack moved to ports 3200/3202/5283/5284 (old ports now used by another checkout). Worker/relay entrypoints now load `.env` via `entrypoints/load-env-file.ts`. Generated `*.tsbuildinfo` files are no longer tracked by git.
(append dated notes here)

### 2026-10-06 — B: storage formats, helpers (early note; final details in B's report)
- `keyBetween(a, b)` / `keysBetween(a, b, n)` are exported from `@tabula/types` (built). Generated keys never end in '0'; legacy timestamp keys are tolerated. Throws `RangeError` when `a >= b`.
- **Cell storage** (`data.records.cells`, keyed by slot) written by B's write path:
  text-like → string · number/currency/percent/rating/duration → number · checkbox → `true` (absent = false) · date → `"YYYY-MM-DD"` · datetime → ISO UTC · single_select → `"opt_…"` · multi_select → `["opt_…"]` ·
  **collaborator → array of raw user uuids** · **attachment → array of raw attachment uuids** · barcode → `{ "text": string }` · json → any JSON ·
  **link → never in cells** (read `data.record_links`; `a_order` orders the b-records inside an a-record's list, `b_order` the reverse). Legacy link arrays in cells are ignored and stripped on the next write.
- **Computed storage** (`data.records.computed`, keyed by slot): the **unwrapped** value (number/string/boolean/ISO date string, or an array for lookups — lookup arrays are flattened one level and hold the target field's *stored* values, e.g. raw rec uuids for a lookup of a link field, `opt_` ids for a lookup of a select; serializer hydrates by the target field's type). Formula/compute errors live in `computed["_errors"] = { "<slot>": "#ERROR! message" }` → serializer emits them as `errors: { fld_…: msg }` and omits the value. Old `{value,status}` objects may exist in old rows — treat an object with a `status` key as legacy and unwrap `.value`.
- Field config is stored with **raw uuids** internally; the wire `FieldDto.config` uses public ids (`tbl_`/`fld_`) and formulas show `{Field Name}`. Use `fieldRowToDto(row, ctx)` from `apps/server/src/modules/schema/field-dto.ts` (B) to serialize fields anywhere (getBase, etc.).
- Record writes from other modules (import, public form submit, contacts) should use `apps/server/src/modules/records/write.ts` (B): `createRecordsInTx(trx, mctx, {...})` / `updateRecordsInTx` — they run validation, links, compute and counters.

### 2026-10-07 — A: query/filter engine and record read path
- **Serializer** `apps/server/src/modules/records/serialize.ts`: `serializeRecords(db, tableId, rows, {fieldIds?, storage?, fields?})`, `serializeRecordsByIds(db, tableId, uuids, opts)`, `loadRecordRows`, `loadRecordNames(db, tableId, uuids) → Map<uuid, name>`, `loadUsers`, `RECORD_ROW_COLUMNS` (`id, version, row_number, manual_order, cells, computed, created_at, updated_at, created_by, updated_by`). Accepts both raw uuids and public ids in collaborator/attachment cells; legacy select labels are mapped to option ids; invalid numbers/dates/datetimes are omitted; `computed._errors[slot]` and legacy `{status:"error"}` → `errors`. Lookup of collaborator/attachment/link targets is hydrated (`link` → `[{id, name}]`). Attachment `url` is a GCS signed URL when the signer works (1.5 s timeout, 60 s back-off), else `/v1/bases/:b/attachments/:att`; `thumbnailUrl` = url for `image/*`, else null. `modified_by` falls back to `created_by` when `updated_by` is null.
- **`POST …/records/query`** body: `{ filter?, sort?: [{field|fieldId, direction}], search?, viewId?, pageSize? (1–500, default 100), cursor?, fields?: ["fld_…"], includeTotalCount? }` → `{ records, nextCursor, totalCount? }`. `totalCount` is returned on the first page (no cursor) by default, or whenever `includeTotalCount: true`. Cursors are opaque, tied to the sort spec (changing the sort with an old cursor → 422 `INVALID_CURSOR`). Ties always break by manual order, then id. A view's saved filter ignores conditions on deleted fields, and a view's saved sorts on deleted fields are dropped. The request filter/sort/projection with an unknown field → 422.
- **`GET …/records/:r`** `?fields=fld_a,fld_b` (optional) → `{record}` (404 if deleted or missing, 422 for a malformed id).
- **`POST …/records/group`** body: `{ filter?, search?, viewId?, groupBy?: [{fieldId, direction?}] (0–3), aggregates?: [{op: count|sum|avg|min|max|filled|empty|unique, fieldId?}] }` → `{ groups: [{ key: string, value, values: unknown[], count, aggregates: { "<op>" | "<op>:<fieldId as sent>": number|string|null } }] }`. If `groupBy` is omitted, the response is a single group covering all matching records (use it for the summary bar). Group values use wire shapes: collaborator → user objects, link → `[{id, name}]`, select → option id; empty group → `null`. min/max on date fields return a date or ISO string.
- **Filter semantics** (`@tabula/filter`, parity between SQL and `evaluateFilter` is tested):
  - A condition missing its operand (`undefined`, `null`, `""`, `[]`, `exactDate` without `date`, `pastNDays` without `n`) is dropped, like Airtable. A group whose conditions are all dropped matches everything.
  - Text ops are case-insensitive. `neq`/`notContains`/`noneOf` match empty cells.
  - Datetime comparisons are by calendar day, in the field's `config.timeZone`, else the requesting user's `core.users.time_zone`, else UTC.
  - Select operands accept option ids (or labels).
  - Accepted aliases:
    - dates: `gt/gte/lt/lte` = `isAfter/isOnOrAfter/isBefore/isOnOrBefore`
    - multi_select, collaborator, link: `anyOf` = `hasAnyOf`
    - single_select: `hasAnyOf` = `anyOf`
    - multi_select, collaborator: `eq` = "is exactly"
  - `isMe` is supported on collaborator and created_by/modified_by fields.
  - A formula with no `resultType` also supports `gt/gte/lt/lte` (numeric).
  - Extra relative dates: `nDaysAgo` and `nDaysFromNow` (both with `n`). Extra range: `thisYear`.
  - Unknown fields or operators, operators not valid for the type, and bad operands → `FilterError` → HTTP 422 problem+json.
- **Exports from `@tabula/filter`:**
  - Operators: `operatorsForFieldType(type, config?)`, `operatorLabel(op, type?, config?)`, `operatorNeedsValue(op)`, `RELATIVE_DATE_OPTIONS`, `WITHIN_RANGE_OPTIONS`.
  - Evaluation: `evaluateFilter(ast, record, fields, ctx?)` and `createFilterPredicate(ast, fields, ctx?)`.
    - `record` is a wire record `{fields: {fld_…: value}}`.
    - `fields` is `[{id, type, config, aliases?}]`.
    - `ctx` is `{now?, timeZone?, currentUserId?, idVariants?, unknownField?}`.
  - Helpers: `filterKindForField`, `normalizeFieldType` (legacy camelCase → snake_case), `parseIsoInstant`, `FilterError`/`isFilterError`, and SQL expression helpers (`sortKeysFor`, `groupKeyFor`, `displayExpr`, …).
  - The old `evaluateFilter(ast, cells, slotMap)` signature is gone. It had no callers.

### 2026-10-07 — D: views
- **View wire DTO** (`GET /v1/bases/:b` tables[].views, `GET …/views`, `GET …/views/:v`, and every view mutation response): `{ id, tableId, name, type, isDefault, visibility, ownerUserId, createdBy, isFavorite, isMine, canEdit, config }`. `config` is always a complete ViewConfig (defaults filled; legacy `sort`/`group`/`visibleFields` keys migrated on read). `canEdit` = false for a locked view unless you created it or are a base creator, and personal views are only ever visible/editable to their owner.
- ViewConfig additions (all optional, backward compatible): `kanban.collapsedStacks?: string[]`, `kanban.cardFieldIds?: string[]`, `calendar.mode?: "month"|"week"`, `gallery.cardFieldIds?: string[]`. Unknown config keys are rejected (422) on write; invalid stored keys are dropped on read.
- New: `GET …/views/:v` → `{view}`. `POST …/views` takes `config?: Partial<ViewConfig>`, merged over type defaults (kanban → first single_select/collaborator, calendar/timeline → first (two) date fields, gallery/kanban cover → first attachment, form → all editable fields, primary first and required). `POST …/views/:v/duplicate {name?}` places the copy right after the original (locked → collaborative). `POST …/views/reorder {viewIds}` re-keys with `keysBetween`; views the caller can't see keep their slots. `DELETE` → 409 `{meta:{reason:"LAST_VIEW"}}` if it would leave the table without a shared view. Missing view → 404; locked/personal edit by others → 403. View mutations record `inverseOps: null` (not undoable via base undo).
- Web: views client is `apps/web/src/lib/api-areas/views.ts` (`viewsApi`, `viewRecordsApi`, `createFormShare`). `ViewsSidebar` accepts `onCreateView(type, visibility, name?)` and does rename/duplicate/delete/reorder/favorite/lock itself (reads `baseId` from route params, `tableId` from `view.tableId`; optional `baseId`/`tableId` props override). `FormsIndex({baseId, onOpenForm?})` is ready for F's Forms tab. `table-grid.tsx` mounts C's `GridView`/`RecordDrawer` automatically when those files exist (`import.meta.glob`) and owns the `?record=` URL param.
- **Bug for G/F:** `POST …/records/query` returns an empty 200 body when the request has an `Idempotency-Key` header (api.log: "Reply was already sent"). `request()` in `api.ts` now adds that header to every POST, which breaks C's GridView loading. D's views bypass `request()` for record queries (`postRead`) as a workaround.

### 2026-10-07 — B: final schema / record-write / compute contracts
- **Record writes** (all return full wire records from A's `serializeRecordsByIds`, new `version` included): create `201 {record}`, batch create `201 {records}` (items may carry an optional client `id`, `rec_…` or uuid; an existing id → 409), PATCH `200 {record}` + `ETag: "<version>"` (`version` in the body or `If-Match` → 409 `VERSION_CONFLICT` with `meta.currentVersion`), batch PATCH `200 {records}`, DELETE / batch-delete `204`, duplicate `201 {record}` (placed right after the source, links copied), move `200 {record}` (`after` wins over `before`; neither → top).
- **Write errors** (problem+json): unknown field → 422 `UNKNOWN_FIELD`; read-only/computed field (formula, lookup, rollup, count, autonumber, created/modified time/by, button) → 422 `FIELD_READ_ONLY`; bad value → 422 `FIELD_VALIDATION_FAILED` (`meta.field` = `fld_…`); empty or >500 batch → 422; the same record twice in one batch → 422 `DUPLICATE_RECORD_ID`; missing/deleted record → 404 `RECORD_NOT_FOUND`; plan record limit → 402 `PLAN_LIMIT_EXCEEDED`. Input keys may be `fld_` ids, raw uuids, or field names. `typecast: true` maps labels to option ids and creates missing options (the response's field config then includes them; a `field.updated` op is emitted).
- **Links**: `data.record_links` is the only source of truth. Writing a link field replaces that record's side, in the given order; targets must be live records of the linked table (422 otherwise); `allowMultiple: false` rejects >1 target (422). Link fields created with `POST …/fields` get a relation and an inverse field in the linked table (named after the source table, deduped; override with body `inverseName`). Self-links have no inverse field. Deleting a link field deletes the relation and the inverse field. Deleting a table deletes link fields in other tables that point at it.
- **Lookup storage (changed)**: a lookup of a **link** field now really stores raw linked-record uuids (it stored names before; the contract always said uuids). The serializer hydrates them to `[{id, name}]`. Formulas and rollups get names (select labels, user names, attachment filenames, linked primary values) at compute time.
- **Recompute through link names**: when a record's primary field changes, every link field pointing at its table counts as changed for the linking records. Lookups, rollups and formulas that show linked names (including ones two links away) refresh. Those records are reported in `records.computed` ops.
- **Fields**: `FieldDto` also carries `isReadOnly: boolean` (and `tableId`). Field name conflicts → 409 `CONFLICT`; cycles → 422 `CYCLE_DETECTED` ("Circular reference: {A} → {B} → {A}", `meta.cycle`); formula syntax/unknown refs/self refs → 422; `ai_generated` and unknown types → 422. Formula expressions are accepted with `{Field Name}`, `{fld_…}` or `{uuid}` refs and stored by id; responses always show `{Current Name}` (renames are safe). Formula, lookup, rollup and count fields are backfilled synchronously for tables up to 5,000 records; larger tables go to the compute worker. Propagated changes over 2,000 records per field are also deferred: `data.computed_stale` rows are written and a COMPUTE job is enqueued after commit.
- **For A (open gaps — read side only)**: lookups are classified as `array` kind, and `textOfJson`/`textExpr` read the stored values. So for a lookup whose target is a link, collaborator, single/multi select or attachment, text filters (`contains`/`eq`/…), search and sort compare raw uuids or `opt_` ids instead of names/labels. Plain collaborator sort and `isMe` already work. Suggested fix in `packages/filter/src/sql-exprs.ts`: give `SqlFieldInfo` an optional `lookupTarget: SqlFieldInfo` (with `link` info when the target is a link field). Then make `displayExpr`/`sortKeysFor`/text ops for lookups map each element `e` of `arrayExpr(jsonExpr(f))` by the target kind, reusing the existing per-kind pieces: select → option label via the `unnest(ids, labels)` pattern; collaborator → `userNameSql(e)`; link → the peer's primary `displayExpr` via `data.records pt WHERE pt.table_id = <target.link.peerTableId> AND pt.id = (e#>>'{}')::uuid`; attachment → `data.attachments.filename`. Sort by the first element's display text. Mirror this in `evaluateFilter` (the wire record already has names for these lookups).

### 2026-10-07 — F: kernel, realtime, events/jobs, history, base shell
- **Kernel** (`apps/server/src/kernel/mutation.ts`): `mctx.afterCommit(fn)` runs `fn` after the surrounding transaction commits (registration order; errors logged, never thrown; dropped on rollback). When you pass your own `trx` to `withBaseTx(…, trx)`, open it with `runTransactionWithAfterCommit(db, fn)` so nested callbacks wait for the outer commit (`afterCommitOf(trx, fn)` registers on such a trx directly). The realtime Redis publish is an after-commit callback. The kernel adds to every outbox payload: `tableId` (when the change touches exactly one table), `tableIds`, `recordId` (for `aggregateType: "record"`), and `clientMutationId`. The outbox `actor` is the real `{type, id, via}`.
- **Client mutation id**: the API reads `X-Tabula-Client-Op-Id` (fallback `Idempotency-Key`) into the change log and onto realtime frames as `clientMutationId`. Web `request()` sets `X-Tabula-Client-Op-Id` on every mutating call outside `/v1/auth/*`, plus the same value as `Idempotency-Key` for `/v1/bases/*` and `/v1/workspaces/*`. Pass `clientOpId` in `request()`'s init to choose the id. `isOwnClientOp(id)` (api.ts) tells whether a frame came from this tab. (D's 2026-10-07 report that `records/query` returns an empty body when it has an Idempotency-Key no longer reproduces: query, a replayed query and a replayed create all return full bodies.)
- **Realtime protocol** (`@tabula/realtime-protocol`): the `change` frame is `{type:"change", baseId, seq, kind?, tableIds, tableId?, recordTableIds, recordIds, recordsChanged, schemaChanged, clientMutationId, ops (public-id hints), actor:{type, id:"usr_…"|null}}`. Only public ids, never raw cells. Presence: the client sends `{type:"presence", baseId, state:{tableId?, viewId?, recordId?, cell?:{recordId, fieldId}}}`. The server answers with full snapshots `{type:"presence", full:true, peers:[{connId, user:{id, name, email}, color, state, updatedAt}]}`. Entries expire after 90 s; the client heartbeats every 30 s. `subscribe {baseId, afterSeq?}` replays up to 500 missed changes, or sends `resync_required {reason: catch_up_truncated|change_log_gap|client_ahead, headSeq}`. Subscribing twice on one socket is a no-op.
- **Web realtime** (`features/base/BaseSessionProvider.tsx`): one socket per open base, with reconnect backoff in `RealtimeClient`. It invalidates per §7 (`["records", b, t]`, `["record", b, t, r]`, `["bases", b]` + `["views", b]` on schema changes, `["undo-state", b]`). `useBaseSession().setPresence(patch)` merges presence (the base shell reports the table and view, and the `?record=` param is tracked automatically). C/D can call `setPresence({cell: {recordId, fieldId}})` for the selected cell. Other users' presence is in `usePresenceStore` / `useOtherUsers()`.
- **Event bus** (`@tabula/events` BullMQ): fan-out per consumer group. `subscribe(topic, group, handler)` registers `group` in the Redis set `tabula:evt-groups:<topic>` and consumes queue `evt__<topic>__<group>`. `publish` adds the event to every registered group's queue (job id = event id, so a re-published row is deduped). Different groups each get every event; processes in the same group share the work. Queue objects and their Redis connection are cached per bus. The relay claims outbox rows with `FOR UPDATE SKIP LOCKED` and has an overlap guard. Worker consumers today: `collab-notifications`, `search-indexer` (each logs `"Domain event consumed"` with the group and event id). The automation engine (G) reads `data.outbox_events` directly.
- **Endpoints** (F):
  - `GET /v1/bases/:b/collaborators` → `{collaborators:[{id:"usr_…", name, email, role}]}`.
  - `PATCH /v1/bases/:b {name}` → `{base:{id, name}}`. `DELETE /v1/bases/:b` → 204. `POST /v1/bases/:b/duplicate {name?, withRecords?}` → `{id, name}`. All three need `base.manage_schema` (403 otherwise) and return 404 for a missing base. Names are trimmed; blank → 422.
  - `POST /v1/workspaces {name}`, `PATCH /v1/workspaces/:w {name}`, `DELETE /v1/workspaces/:w`, `GET /v1/workspaces/:w/members` → `{members:[{id, name, email, role}], invitations:[{id, email, role, expiresAt}]}`.
  - History: `GET /v1/bases/:b/undo-state` → `{canUndo, canRedo, undoLabel, redoLabel}`. `POST …/undo` / `POST …/redo` → `{changeSeq, undoneSeq|redoneSeq, description, tableIds}`, or 409 `NOTHING_TO_UNDO` / `NOTHING_TO_REDO`. The stack is per user. Changes with `inverse_ops: null` (e.g. view edits) are not on it, and unsupported op kinds are skipped. A new edit clears that user's redo stack.
  - Trash: `GET /v1/bases/:b/trash` → `{records, tables, fields}` (last 30 days). `POST …/trash/restore {recordId|tableId|fieldId|deletionBatchId}` → `{changeSeq, restored, tableIds}` (404 if nothing to restore).
  - Fallbacks: `POST …/tables/:t/duplicate` and `POST …/tables/reorder` are registered by F (`base/table-fallback-routes.ts`) only when B's schema module hasn't registered them.
- **Web shared UI** (F, `apps/web/src/app`): `toast.tsx`: `toast.success(msg, {action?, durationMs?})`, `toast.info`, `toast.error(err, fallback?)`, `errorMessage(err)`. `<ToastHost/>` is mounted in the root route. `ui.tsx`: `Dialog`, `ConfirmDialog`, `PromptDialog`, `DropdownMenu`, `Avatar`, `isTypingTarget`, `uiStyles`. Any 401 outside `/v1/auth/*` redirects to `/login?next=<current path>` (`setUnauthorizedHandler` in api.ts).
- **Notes for other workstreams**:
  - **C**: `FieldManager` only closes on Escape when focus is inside the panel. Clicking Done works.
  - **G**: a newly created automation also fires for `record.created` events written before the automation existed. Its runs then fail with "The triggering record no longer exists" when those records are gone.
  - **E**: the search indexer stores record titles as "Record N", not the primary field value.

### 2026-10-07 — A (follow-up): lookups filter, search, sort and group by display text
- Closes B's "open gaps" note above. `SqlFieldInfo` has an optional `lookupTarget: SqlFieldInfo | null` (the looked-up field, with `link` info when it is a link field). The server's `loadSqlFieldInfos` resolves it from `config.targetFieldId` (raw uuid or `fld_`; legacy `lookupFieldId` accepted), so every caller of `executeRecordQuery` / the group query gets it.
- Each stored lookup element maps to the text the serializer shows. Select option id → option label (unknown ids stay as the raw id). User uuid → `display_name`, falling back to email. Record uuid → the linked record's primary display (live records only). Attachment uuid → filename. Other targets keep their stored text.
- **Filters and search:** text ops (`contains`, `notContains`, `eq`, `neq`) and search on a lookup compare the elements' display texts joined with `", "`. Stored ids never match.
- **Empty checks:** `empty`/`notEmpty` on a lookup of a collaborator, attachment or link ignore dangling ids (user, attachment or record no longer exists), matching the serialized value that drops them.
- **Sort:** a lookup sorts by its first element. Number targets sort numerically, select targets by option order, all others by lower-cased display text of the first non-empty element. Empties go last.
- **Group:** a lookup groups by its joined display text. The group `value` is that string, e.g. `"Bob Other, Ada Tester"`.
- Lookups with no resolvable target behave as before (stored text).
- **`evaluateFilter`:** `EvalField` has an optional `lookupTarget: {id, type, config}`. When it's given and the target is a single/multi select, wire `opt_` ids map to labels for text ops. Collaborator/attachment/link lookup values are already hydrated objects on the wire, so their `name`/`filename` is used either way. New export: `lookupTextOf(field, value)`.
- **For G:** `apps/server/src/modules/automations/filter-eval.ts` builds `EvalField`s without `lookupTarget`, so automation conditions on a lookup of a select still compare option ids. To fix, pass `lookupTarget: {id, type, config}` of the target field.
- Plain collaborator sort orders by user name (verified with two named users, asc and desc).

### 2026-10-07 — E: sharing, attachments, import/export, search, notifications, contacts, comments
- **Deep links** (search hrefs, notification `link`, comment notifications): `/bases/bas_??table=tbl_?&record=rec_?[&comment=cmt_?]`. The old `?tableId=&recordId=` shape is gone. F's `routes/base.tsx` reads `?table=` and switches the active table, resetting the view and the tab to data. D's grid opens `?record=`. Client-side navigation to these links uses `navigateToLink(router, href)` from `features/search/SearchPalette.tsx`, which navigates and then dispatches `popstate` so a grid that's already mounted picks up the new `?record=`.
- **Shares** (`modules/share`). Authenticated routes:
  - `GET/POST /v1/bases/:b/shares`
  - `PATCH/DELETE /v1/bases/:b/shares/:shareId`
  - `POST ?/:shareId/regenerate`: the old token then returns 404.

  Tokens are `shr_<prefix>.<secret>`. `share.url` points at the public app: `/s/<token>` for view and base shares, `/f/<token>` for form shares.

  Public routes, all under `/v1/public/shares/:token`:
  - `GET` (metadata, hidden fields stripped)
  - `POST /records/query` (the view filter is always applied)
  - `GET /records/:recordId`
  - `POST /submit` (form shares only)
  - `POST /attachments/presign`, `PUT /attachments/:id/upload`, `POST /attachments/complete`

  Password shares answer 401 until `POST ?/unlock {password}` returns `{unlockToken}`, which is then sent as the `X-Share-Unlock` header. A revoked, expired or deleted target returns 410 with `meta.reason` set to `revoked`, `expired` or `target_deleted`. Form submit validation errors are 422 with per-field `fieldErrors`.
- **Attachments** (`modules/attachments`):
  - Upload flow: `POST /v1/bases/:b/attachments/presign`, then `PUT` to the returned URL (on the local driver that is `?/attachments/:id/upload`), then `POST ?/attachments/complete`. Complete sniffs the real mime type and image dimensions; oversize uploads are rejected.
  - Other routes: `GET ?/attachments/:id` (metadata), `GET ?/attachments/:id/content` (auth-checked bytes), and `POST /v1/bases/:b/tables/:t/records/:r/attachments` to attach to a record.
  - Web helper: `uploadAttachment` in `apps/web/src/lib/api-areas/files.ts`.
  - **For A:** `records/serialize.ts` `loadAttachments` now handles attachments with `storage_driver = "local"` by giving them a signed `/v1/public/files/<token>/<filename>` URL (via `localAttachmentUrl` in `attachments/service.ts`). Before this, local uploads were given a GCS URL or the JSON metadata path, and images didn't render. Keep this branch.
- **Import:** `POST /v1/bases/:b/import {tableId, rows, importJobId?, rowOffset?, totalRows?, final?, typecast?}` returns `{importJobId, rowsImported, rowsFailed, errors:[{row, message}], totalImported, totalFailed, status}`. Rows go through B's write path (`wave4/record-writer.ts`). The web side (`features/import/parse.ts`) parses CSV and XLSX and sends the rows in chunks.
- **Export:** `GET /v1/bases/:b/tables/:t/export?format=csv|xlsx&viewId=` uses the view's filter, sort and visible fields, and outputs computed values as display text. CSV starts with a BOM, uses CRLF line endings and guards against formula injection: cells starting with `= + - @`, tab or CR get a `'` prefix. Attachment cells list their file URLs.
- **Search:** `GET /v1/search?q=&limit=&workspaceId=&baseId=` returns `{results:[{kind:"base"|"table"|"record", id, title, subtitle, href}]}`. Record titles come from the primary field's text read straight from `data.records`, so the "Record N" titles in F's search-indexer note don't affect it.
- **Notifications:**
  - `GET /v1/notifications?unreadOnly=true&limit=` returns `{notifications:[{id:"ntf_?", category, title, body, link, readAt, read, createdAt, workspaceId, baseId, actor:{id, name, email}|null}], unreadCount}`.
  - `POST /v1/notifications/:id/read`, `POST /v1/notifications/:id/unread`, `POST /v1/notifications/read-all`.
  - Notifications are created for mentions and for replies to your comment.
- **Contacts:** `GET /v1/workspaces/:w/contacts?q=`, `POST /v1/workspaces/:w/contacts`, `PATCH/DELETE /v1/workspaces/:w/contacts/:id` and `POST /v1/workspaces/:w/contacts/merge {survivorContactId, mergedContactId}`. Merge fills the survivor's empty fields, moves links from the merged contact to the survivor, and rejects records that aren't contacts. The web page is `routes/contacts.tsx` (`?workspaceId=`).
- **Comments:**
  - `GET/POST /v1/bases/:b/tables/:t/records/:r/comments`
  - `PATCH/DELETE /v1/bases/:b/comments/:id` (author only, otherwise 403)
  - `POST /v1/bases/:b/comments/:id/reactions {emoji}` and `DELETE ?/reactions/:emoji`

  Mention markup in `body` is `@[Display Name](usr_?)`. Viewers can read comments but get 403 when posting or reacting. The web component is `RecordComments` (`features/comments`).

### 2026-10-07 — G: idempotency, automations, auth/account, permissions

- **Idempotency (`apps/server/src/http/idempotency.ts`):**
  - The `onSend` hook is synchronous and only captures the payload; the record is persisted in `onResponse`. First responses now carry their body. A handler that sends a reply from a hook must still `return reply`.
  - Exempt (the key is ignored): read-only POSTs matching `/records/(query|group)$`, and anonymous requests (no `request.user`, e.g. public forms).
  - Same key + same body returns the stored status and body verbatim, with the header `idempotent-replayed: true`. A stored 204 replays as an empty 204.
  - Same key + different body returns `409 IDEMPOTENCY_CONFLICT`. A key still in progress also returns 409, unless its lock has expired.
  - 5xx responses are not cached (the key is deleted).
  - `request.idempotencyKey` and `request.idempotencyWorkspaceId` are gone (nothing used them).
- **Automations:**
  - The engine runs inside the worker (`entrypoints/worker.ts`) and reads `data.outbox_events` directly.
  - Changed fields are computed by diffing `base_changes.ops` against `inverse_ops`.
  - Migration `0015` adds `data.automations.enabled_at`. It is set when an automation is turned on, and events older than it never trigger the automation.
  - Actions call the HTTP API with header `x-tabula-client-op-id: aut:<runId>`. Changes caused by a run never re-trigger that automation, and causation depth is capped at 8.
  - **E:** form submissions are written as actor `system` with `via:"api"`. The consumer detects them through `data.share_submissions` and waits up to 5 s for that row. Passing `via:"form"` (and the form view id) into the submit mutation's change payload would remove the wait.
- **Auth:**
  - Per-IP limits are configurable via `AUTH_SIGNUP_MAX_PER_IP` and `AUTH_LOGIN_MAX_PER_IP`. Defaults are 30 and 50 in production, 2000 elsewhere, so dev test signups no longer hit 429.
  - MFA login returns `{mfaRequired:true, mfaToken}`; the client then calls `POST /v1/auth/mfa/verify {mfaToken, code}`.
  - Google sign-in links to an existing account only when `email_verified` is true.
- **Permissions (phase 2):**
  - `resolveBaseContext` and `resolveTableContext` now require a real base role from `compileForUser`. Org membership alone no longer grants access to a base, so every route using these helpers returns 404 for org members who have no workspace/base grant.
  - `GET /v1/search` and `GET /v1/workspaces/:w/bases` only include bases where the user has a role.
  - `view.create_collaborative` is now editor+ (commenters and viewers no longer have it).
  - Views routes:
    - Creating or duplicating a shared view needs `view.create_collaborative`; a personal view needs commenter+.
    - Rename, config, delete and reorder of non-personal views need `view.update`; personal views stay owner-only.
    - Favorites are open to anyone who can read the base.
  - **D:** `serializeView`'s edit flag (from `canEditView`) still reports `true` for viewers on collaborative views. Viewers will now get 403 if the grid PATCHes shared view config (column widths and similar). Those changes should go to personal overrides, or the UI should hide the controls.
- **Account UI (for F, who owns `router.tsx`):**
  - Please register `/account` → `AccountPage` from `features/account/AccountPage.tsx` (optional `onBack`). It covers profile, password, TOTP MFA and sessions.
  - Please register `/invite/$token` → `AcceptInvite` from `features/account/AcceptInvite.tsx`, with props `{token, onDone({baseId, workspaceId}), onSignIn}`. `onSignIn` should go to `/login?next=/invite/<token>`; `onDone` should navigate to the base (or home when `baseId` is null).
  - Add an "Account" entry to the user menu.
- **Tooling:** the cursor-ide-browser MCP could not keep a tab open, so UI checks used headless Edge via `playwright-core`.

### 2026-10-07 — C: grid, cells, field UI, record drawer, field manager
- **Record and field clients** (`lib/api-areas/records.ts`, `fields.ts`) go through `request()`, so every write carries the client op id and Idempotency-Key. After G's idempotency fix, query, create, a replayed create and attachment presign all return full bodies; there is no client opt-out any more. New: `recordsApi.aggregate(baseId, tableId, {filter?, search?, aggregates:[{op, fieldId?}]})` → `{count, "<op>:<fieldId>": value}` (wraps `POST …/records/group` without `groupBy`).
- **Grid summary bar:** while not every page is loaded, the summary uses `recordsApi.aggregate` (query key `["records", b, t, "summary", viewId, filter, search, ops]`, so the normal `["records", b, t]` invalidation refreshes it). Otherwise it is computed on the client. If the server rejects an op, the query retries without `unique` ops, and those cells show the client value with a trailing "+".
- **`RecordDrawer`** accepts optional `hiddenFieldIds?: string[]` (shown under a "hidden fields" toggle) and `canEdit?: boolean` (default true), in addition to the §8 props.
- **`FieldManager({baseId, table, onClose, viewId?, hiddenFieldIds?, onHiddenChange?})`:** pass `viewId` and the panel shows per-field "Visible" toggles that save the view's `hiddenFieldIds` itself. The controlled `hiddenFieldIds`/`onHiddenChange` pair still works. Without either, no toggles are shown.
- **`@tabula/field-ui`:**
  - `FieldUiServices.portal?(node): ReactNode`. When given, popovers and the link-record picker render through it. The web services pass `createPortal(node, document.body)`, so popups aren't clipped by grid or dialog overflow.
  - z-index: `.tfu-pop` 1150, `.tfu-modal-back` 1140, above dialogs at 1100.
  - The cell-mode date/datetime editor is a text input. It accepts typed dates (`12/25/2026`, `2026-12-25`, `Dec 25`, `today`, `tomorrow`, `2026-11-05 09:30`), plus a calendar button that opens the native picker. Form mode keeps the native inputs.
  - Editors commit on unmount in a StrictMode-safe way.
  - Email/URL/phone editors use `type="text"` with `inputMode`.

### 2026-10-07 - D (follow-up): view edit rights, unload saves, load errors
- **`canEdit` now follows the base role.** For collaborative and locked views it is `false` unless the user has `view.update` (editor or higher). Locked views also still need the view's creator or a base creator. Personal views stay owner-only, whatever the role. `views/serialize.ts` exports `viewEditRights(snapshot)`, which returns `{isBaseCreator, canUpdateShared}`; `serializeView` and `canEditView` take it (a plain boolean still means "is base creator"). This answers G's note above. The web toolbar, sidebar and per-type settings are already read-only when `canEdit` is false. **C:** GridView should also skip view config PATCHes (column widths, frozen columns) when `view.canEdit` is false, or viewers will get 403s.
- D's earlier report that `records/query` returns an empty body with an `Idempotency-Key` is fixed (G). D's views still send record queries without that header (`postRead`); that is harmless.
- `viewsApi.patchOnUnload(baseId, tableId, viewId, {config})` is a `keepalive` PATCH. `useViewConfig` calls it on `pagehide`, so a debounced view change made just before a reload or tab close is still saved.
- `ViewsSidebar`'s `onCreateView` may return a Promise; if it rejects, the error is shown in the sidebar's create prompt. `base.tsx` passes `createViewMutation.mutateAsync(...)`.
- View record queries (`useViewRecords`) retry 5xx and network errors up to 5 times with backoff (1 s up to 8 s). Kanban, calendar, gallery, timeline and list show a "Couldn't load records." banner with a Retry button (`features/views/RecordsStatus.tsx`) instead of loading forever.
- `FormsIndex` adds a newly created form view to the `["bases", b]` and `["views", b, t]` caches before calling `onOpenForm`, so the Data tab opens on the new form.

### 2026-10-07 — E (follow-up): search index titles
- The search indexer (`collab/record-index.ts`) titles records with the primary field’s display text (A’s `loadRecordNames`), falling back to `Record N` when it’s empty. It handles single and batch record events, table reindexes on primary-field changes (`table.updated {primaryFieldId}`, and `field.updated`/`field.type_changed` on the primary or when the primary is computed), undo/redo and trash restore. Touched linked tables with a computed primary are reindexed when they have 5,000 records or fewer.
- `GET /v1/search` record titles use the same display text, and records also match on their indexed title, so formula, number, select and link primaries are searchable.
- New: `POST /v1/bases/:b/search/reindex` (needs `base.manage_schema`) returns `{tables, records}` after rebuilding the base’s record index.

### 2026-10-07 - A (follow-up 2): group query 500 "could not determine data type of parameter $n"
- Cause: `unique` aggregates on single/multi select, link, and lookup-of-select/link fields. The SQL builder created a sort key, added its parameters, then discarded the SQL, and Postgres rejects parameters it never sees. Fixed, and no group-query combination returns 5xx any more.
- `@tabula/filter` additions:
  - `groupValueKeyFor(f, a, p)` returns the group key only. Use it when you don't need the sort key. `groupKeyFor` still returns `{key, sort}`.
  - `SqlParams.mark()` / `rollback(mark)` drop parameters whose SQL you throw away.
- Rule for anyone building SQL with `SqlParams`: every parameter you add must appear in the final SQL. Either use the expression or roll it back. The filter unit tests check this for every field kind.

### 2026-10-07 — C (follow-up): editor ids, uploads outside the grid, record-edit rights, full-height grid scrollbar
- **`FieldValueEditor`** takes `id?: string` and `labelledBy?: string`. `id` goes on the editor's main control: the text, number, date, long text and checkbox inputs, the select/collaborator picker box (`role="combobox"`), the link-record and attach-file buttons, and the rating group. So `<label htmlFor={id}>` works for native inputs. Picker-style editors aren't native form controls, so also pass the label's own id as `labelledBy` (it becomes `aria-labelledby`). Rebuilt `@tabula/field-ui`.
- **D's `ValueEditor`** (`features/views/field-value.tsx`) forwards `id`/`labelledBy`, renders the shared editor in `mode="form"`, and wraps it in C's `FieldServices` provider. That gives forms and the filter builder working attachment uploads, collaborator lists, link-record search and "add option". `FormView` gives each label `id="form-<fieldId>-label"` and passes it as `labelledBy`. Any other place that renders `FieldValueEditor` outside the grid or drawer needs `<FieldServices baseId>` (exported from `features/grid/field-services.tsx`) around it, or uploads show "Uploads unavailable".
- **`useBaseRole(baseId)`** (`features/grid/field-services.tsx`) returns `{role, canEditRecords, canEditSchema}`. These are `undefined` until loaded. The role is read from `GET /v1/bases/:b/collaborators` and matched to `/v1/auth/me`; query key `["base-role", baseId]`. `canEditRecords` is editor or higher; `canEditSchema` is creator or owner (matches `@tabula/permissions`).
- **`GridView`** gains optional `canEditRecords` and `canEditSchema` props. Both default to `useBaseRole`, and both are `false` while the role is loading. `canEdit` now means only "can change this view's config". Record editing, adding, deleting, pasting, filling and row reorder follow `canEditRecords`. Edit, insert, duplicate and delete field follow `canEditSchema`. So editors can edit records in a locked view, while commenters and viewers are read-only. `table-grid.tsx` passes `canEditRecords` to the grid, and `hiddenFieldIds={config.hiddenFieldIds}` plus `canEdit={canEditRecords}` to `RecordDrawer`.
- **Grid paging:** the first page is 200 rows; later pages use the server maximum (500). When not grouped, the grid reserves height for rows not loaded yet (from the server's `totalCount`), so the scrollbar spans the whole table. Scrolling or jumping into that area keeps loading pages until the rows on screen are filled. The footer count follows filter + search, and shows "Loading…" while a new query replaces the old one.
- **`FieldManager`** visibility toggles also invalidate `["views", baseId]` (F's views query), so the open grid updates at once.
- **Removed** (dead after the fallbacks were dropped from `table-grid.tsx`): `features/grid/DomGrid.tsx`, `CanvasTableGrid.tsx`, `CellEditor.tsx`, `features/schema/FieldHeader.tsx`, `features/record/RecordExpandDrawer.tsx`, `features/record/record-drawer.module.css`. `features/grid/grid.module.css` now only has `.status`, which `table-grid.tsx` uses. Nothing in the repo imports `@tabula/grid` any more. `apps/web/package.json` still lists it as a dependency, and the package was not deleted.
