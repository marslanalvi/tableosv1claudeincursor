# TableOS — complete work log

TableOS is an Airtable-style product: workspaces → bases → tables → fields / records / views, plus automations, interfaces, forms, sharing, import/export and realtime collaboration. This document records everything built and fixed so far, newest first, with how each piece was verified.

* Repo: <https://github.com/marslanalvi/tableosv1claudeincursor>
* Branch for the latest work: `cursor/tableos-tabs-import-record-id`
* Architecture source of truth: `architecture/` (mirrored in `docs/architecture/`). Amendments made during this work are summarised in `00-canonical-decisions.md` §15.

---

## How to run it locally

| What | Value |
|---|---|
| Stack | Node 22, pnpm 9.15 monorepo; Fastify + Kysely (Postgres); React 19 + Vite + TanStack Query |
| Isolated dev ports | API `3200`, realtime `3202`, web `5283`, public app `5284` |
| Database | `postgres://tabula:tabula@localhost:5432/tabula_cc` |
| Migrate | `$env:DATABASE_URL="postgres://tabula:tabula@localhost:5432/tabula_cc"; npx pnpm@9.15.0 db:migrate` |
| Typecheck | `npx tsc -p apps/server/tsconfig.json --noEmit` and `npx tsc -p apps/web/tsconfig.app.json --noEmit` |
| Unit tests | `npx pnpm@9.15.0 --filter "@tabula/filter" --filter "@tabula/formula" test` (and other packages' `test`) |
| API checks | `node .data/verify-interfaces.mjs`, `node .data/verify-round.mjs`, `node .data/verify-access.mjs`, `node .data/verify-sync.mjs` |
| UI checks | `$env:PW_VIEWPORT="1366x768"; node .data/r2-shell/pw.mjs .data/r2-shell/look-interfaces.mjs` (screenshots in `.data/r2-shell/shots/`) |

---

## Round 5 (this round): owner-controlled privileges, device approval, API tokens, cross-base data, table ids, Help centre

### 1. Privileges: only the owner manages access

* **Owner-only management.** Inviting, changing roles, ending access, suspending/removing members, approving devices and creating API tokens all require the organization owner (`isOrgOwner`). Other members get `403`. The owner's own membership can't be changed (`409`).
* **Members & access page** (`/admin`, account menu → "Members & access"; `features/admin/AdminPage.tsx`) with four tabs:
  * **People:** invite to a whole workspace or a single base with a role; pending invitations; per-member access table (role per workspace and per base, plus an optional "Access until" date); Suspend / Reactivate / Remove.
  * **Devices**, **API tokens**, **Security** (below).
* **Server:** `apps/server/src/modules/members/routes.ts` (`GET /v1/orgs`, `GET /v1/orgs/:orgId/access`, `PUT …/members/:userId/grants`, `PATCH`/`DELETE …/members/:userId`, device and token routes). Grant changes bump `perm_epoch` and drop the permission snapshot caches, so they apply to signed-in users at once. Grant expiry (`expiresAt`) is enforced when permissions are compiled.
* The workspace Share dialog no longer offers "Owner" as an invite role and points to Members & access.

### 2. Device approval (replaces MAC-address restriction)

Browsers can't read a MAC address, so each browser gets a random device key in a long-lived httpOnly cookie (`tableos_device`); only its SHA-256 is stored (`core.org_devices`, migration `0068_access_control.sql`).

* In an org that requires approval (the default; toggle in **Security**), a non-owner's new device starts `pending`. That org's data is unreachable from it until the owner approves it. The owner is always exempt.
* The member sees a banner (`DeviceBanner.tsx`, polling `GET /v1/devices/current`) that unlocks automatically once approved.
* The owner can approve, deny, revoke, rename or forget devices. Checks run centrally on every request (`access/devices.ts`, request context `access.blockedOrgs`), with a 15 s cache that is invalidated when an invitation is accepted or a device decision is made.

### 3. API tokens with read / write / delete types

* Owner-only, in **Members & access → API tokens**: name, any combination of **read**, **write**, **delete**, all bases or chosen bases, optional expiry. The raw token (`tos_…`) is shown once; only its hash is stored (`core.api_tokens`).
* `Authorization: Bearer tos_…` is accepted by the auth hook. `access/api-tokens.ts → requiredScope` limits tokens to the record API and schema reads and maps each method/path to the needed scope; tokens act with the owner's permissions, narrowed by scope and base list.
* **Table-id-only API:** `/v1/tables/:tableId/…` resolves the base and forwards to `/v1/bases/:baseId/tables/:tableId/…` (`public-api/routes.ts`); `GET /v1/api/bases` lists reachable bases and tables.
* `kernel/mutation.ts`: token writes have no session, so `session_id` is stored as `NULL` (it was `""`, which failed the uuid column).

### 4. Data from other bases: synced tables and cross-base links

* **Synced tables** (`modules/sync/`, migration `0069_table_syncs.sql`): a read-only copy of another base's table in the same org.
  * The engine (`engine.ts`) maps field types (computed fields become their result type, attachments become text, buttons are skipped), reconciles schema (create, rename, retype, delete) and copies records by content hash in batches of 500.
  * The worker (`scheduler.ts`) re-syncs about 2 s after the source table changes, plus a sweep every minute for syncs that are due (default every 5 minutes).
  * Syncs run with the creator's read access to the source; losing access puts the sync in `error`.
  * Synced fields and records are read-only (`guard.ts`, `403`), but you can add your own fields to a synced table. "Stop syncing" turns it into a normal table.
  * UI: "Sync from another base" in the add-table menu and dialog, ⇄ tab badge, a sync bar (last sync, Sync now, Pause/Resume) and tab-menu actions.
* **Cross-base links:** a link field can target "a table in another base" (`FieldDialog.tsx → CrossBaseLinkPicker`). It creates or reuses a synced copy and links to it, so lookups and rollups work unchanged.

### 5. Table ids

Table ids were already globally unique UUIDv7 public ids (`tbl_…`), unique across all bases. They are now visible: the table tab menu → **IDs & API…** shows the base, table and field ids with copy buttons and a `curl` example. The expanded record has **Copy record ID**.

### 6. Record ID hidden by default in new views

New views (and a new table's first view) hide Record ID fields; they can be shown from **Fields** (`bootstrap-default-table.ts`, view creation defaults).

### 7. Help centre

`/help/:topic` (account menu → "Help & documentation"; readable signed out) with search and 20 topics: getting started, IDs, fields (list generated from `FIELD_TYPES`), editing records, views, links/lookups/rollups, synced tables, formulas, import/export, forms, interfaces, automations, sharing, search/notifications/contacts, roles and privileges, device approval, account/2FA, API tokens, API reference with examples and errors, and keyboard shortcuts (`features/help/`).

### Verified

* Typecheck: server and web clean.
* `node .data/verify-access.mjs`: 39 checks covering owner-only management, grant expiry, suspend/remove, device approval, and token scopes, base limits and revocation.
* `node .data/verify-sync.mjs`: initial sync, live updates via the worker, renamed/deleted fields and records, read-only guard, links and lookups to a synced table, pause, stop syncing, and refusal for a source you can't read.
* `verify-round.mjs` and `verify-interfaces.mjs` still pass.
* Playwright: `.data/r2-shell/r5-look.mjs` (Help pages, search, account menu, every Members & access tab) and `r5-crossbase.mjs` (link to a table in another base from the field dialog).

## Round 4: Record ID field, "Fields" panel, view creation, Forms studio, Interfaces (commit `e7153c7`)

### 1. Record ID is a real, visible, hideable field on every table

Every record already had a unique public id (`rec_…`). It is now shown as a field.

* **New tables** get a **Record ID** field automatically (`apps/server/src/modules/base/bootstrap-default-table.ts`).
* **Existing tables** were backfilled: migration `0064_record_id_on_every_table.sql` adds a Record ID field to every live table that lacks one (named "Record ID (system)" if "Record ID" is taken), appended after the existing fields.
* `0065_record_id_field_uuidv7.sql` re-keys those field ids to UUIDv7. The first version of 0064 used `gen_random_uuid()` and broke `GET /v1/bases/:id` with a 500 ("encodePublicId requires a UUIDv7"). 0064 itself now uses `public.uuidv7()`.
* **Hide, but don't lose it:** it appears in the view's **Fields** panel and can be hidden per view like any field. The server refuses to delete or change the type of a table's last Record ID field (`409 RECORD_ID_REQUIRED`, `field-ops.ts → assertNotLastRecordIdField`).
* **Filtering by Record ID** (exact match, contains, starts with…) works through the virtual field `__record_id__`. Exact matches were silently returning nothing because SQL `data.encode_public_id` used numeric `/`, which rounds. `0067_encode_public_id_div.sql` switched it to `div`/`mod`, so SQL and JS ids now match.

### 2. "Hide fields" is now "Fields"

`ViewToolbar.tsx`: the toolbar button and its popover are titled **Fields**. The button reads `Fields · N hidden` when some fields are hidden.

### 3. Creating a view is always visible

Previously the only entry point was a "Create…" popover at the bottom of the views sidebar, which was easy to miss. There are now three entry points:

1. **Toolbar view switcher.** Click the view name in the toolbar to see every view of the table (current one ticked) and a **Create a view** section with every type (Grid, Form, Calendar, Gallery, Kanban, Timeline, List, Gantt).
2. **`+` button** next to "Find a view" in the views sidebar.
3. The sidebar **Create** list is now inline, open by default, and remembers whether it is open or collapsed (`localStorage`).

New views are collaborative for owners, creators and editors, and personal for everyone else. Files: `ViewToolbar.tsx`, `ViewsSidebar.tsx`, `views-sidebar.module.css`, `views.module.css`, `routes/table-grid.tsx`, `routes/base.tsx`.

### 4. Forms tab works as a full form studio

`apps/web/src/features/views/FormsIndex.tsx` was rewritten as a two-pane studio:

* **Left:** all form views across all tables, with a table picker, **+ New form**, search (when there are more than 3 forms) and question counts.
* **Right:** the full form builder with live preview (the same `FormView` used in the Data tab). It also has **Copy public link** (creates a form share link), **Open in Data** and **Delete form** (with confirmation).

### 5. Interfaces (architecture 13), from "Coming soon" to working

**Backend.** Migration `0066_interfaces.sql` adds `data.interfaces`, `data.interface_pages` and `data.interface_versions`. The server code is in `apps/server/src/modules/interfaces/`:

* `model.ts` defines the page and element schemas (Zod) and validates references for publishing.
* `routes.ts` provides the REST API, registered in `http/app.ts`.

| Capability | Endpoint(s) |
|---|---|
| List / create / rename / delete interfaces | `GET/POST /v1/bases/:b/interfaces`, `PATCH/DELETE /:itf` |
| Pages (add, rename, edit layout, delete, reorder) | `/:itf/pages…`. Edits take `expectedRevision`; a stale save gets `409 PAGE_REVISION_CONFLICT`, and deleting the last page gets `409 LAST_PAGE` |
| Publish (validated snapshot) | `POST /:itf/publish`. Errors return `422 INTERFACE_INVALID` with diagnostics; warnings are returned with success |
| Unpublish, version history, restore to draft | `POST /:itf/unpublish`, `GET /:itf/versions`, `POST /:itf/versions/:n/revert` |
| Published runtime | `GET /:itf/runtime` (`410` when unpublished) |
| Element data | `POST …/elements/:elm/query` (records, projected to the element's fields only) and `POST …/elements/:elm/aggregate` (number and chart values computed on the server) |

Security properties:

* Builders (`base.manage_schema`) see drafts. Everyone else sees only the published snapshot.
* Element queries apply the element's own table, view, filter and sort on the server, so the client cannot widen them.
* **Record details** re-checks that the selected record is visible through the source element (`RECORD_NOT_IN_SCOPE`).
* The element query and aggregate POSTs are read-only, so they are excluded from idempotency storage (`http/idempotency.ts`).

**Frontend.** The code lives in `apps/web/src/features/interfaces/` and `apps/web/src/lib/api-areas/interfaces.ts`.

* **Interfaces tab:**
  * a sidebar list with a status for each interface (Draft / Published · vN / Unpublished changes);
  * page tabs, with page menus for rename, move left/right and delete;
  * **Edit / Preview / Published** modes.
* **Templates:** Dashboard (title, record count, sum of a number field, a chart grouped by a select field, a grid), Record review (list plus details), Form, and Blank.
* **Elements:**
  * **Number**: count, sum, average, min, max or unique count; number, currency or percent formatting.
  * **Chart**: bar, line, pie or donut, drawn as SVG.
  * **Grid**, **List** and **Gallery**: with search, "Load more", click to select or open, and an optional "+ New record".
  * **Record details**: follows the selection in another element; editable fields save as you type.
  * **Form**: creates records.
  * **Button**: opens an https, mailto or tel link, or goes to another page.
  * **Text**: headings, bullets and bold.
  * **Divider**.
* **Inspector** (per element): title and width, then:
  * **data source:** table, base view, and a filter built with the same builder as views;
  * **fields:** a picker with ordering and Editable / Required flags;
  * **type-specific settings:** chart, number and button options.
* **Saving and publishing:**
  * Autosave is debounced, with conflict detection.
  * **Publish** shows a diagnostics dialog when there are problems.
  * **Version history** can restore any version to the draft.
  * Interfaces can be unpublished.

**Deliberate MVP limits** (recorded in architecture 13 §18):

* Only base members can use interfaces. There are no interface-only users or share links.
* There is no Redis caching or realtime invalidation for aggregates.
* Layout is a single section with flow layout, not free-form drag and resize.
* The only record context is "record selected in another element".

### 6. Other fixes included in this commit (earlier QA pass)

* **Filters:**
  * Filters are capped at 200 conditions (`FILTER_TOO_LARGE` → 422).
  * Validation is a single bounded walk, so deeply nested input can't overflow the stack (`packages/filter/src/parse.ts`, `views/config.ts`, `http/errors.ts`).
* **Personal views are private in queries:** another user's personal view can't be used as `viewId` in record or group queries (`execute-record-query.ts`, `group-query.ts`).
* **Automations:** webhook URLs, which contain the trigger secret, are only returned to users who can manage the base.
* **Workspaces:**
  * Only workspace owners can rename or delete a workspace.
  * Base-only guests no longer see the workspace member list.
  * Guests' workspace lists only include workspaces they have grants in.
* **Undo/redo of linked-record changes** now restores the links (`history/apply-ops.ts`).
* **Formulas:**
  * Added the architecture-08 function names (`CONCAT`, `DATE_DIFF`, `DATETIME`, `TO_TIMEZONE`, `TEXT`, `JSON_GET`, `ARRAY_SORT`, `ROW_NUMBER`, `CREATED_BY`, …), with aliases to the existing implementations.
  * Lone UTF-16 surrogates are sanitised so they can't fail a write.
  * Rollup `AND()` treats unchecked linked checkboxes as false.
* **Select fields:** deleting a select option clears it from cells (`schema/field-ops.ts`).

### Verification for this round

* Server and web typechecks are clean, and the filter (21) and formula (15) unit tests pass.
* `.data/verify-interfaces.mjs` passes all 26 checks:
  * Record ID present on old and new tables, and protected from deletion;
  * Record ID exact-match filter;
  * interface CRUD and pages;
  * revision conflict and last-page guard;
  * element field projection;
  * metric and chart aggregates;
  * record-detail scope check;
  * publish, versions, revert, unpublish (410) and delete.
* `.data/verify-round.mjs` passes: view creation, Record ID virtual filter, built-in Record ID field value, hidden tables, CSV import.
* Playwright (`look-interfaces.mjs`, 1366×768) passed every step with no console errors:
  * create a Dashboard;
  * open the inspector;
  * publish, and switch to the Published view;
  * create a Record review and select a record (details render);
  * add a Form page and submit a record.
* Playwright screenshots confirm the **Fields** label, the Record ID column, the inline Create list, the `+` button and the toolbar view switcher.

---

## Round 3: table bar, Record ID filter, import reliability, TableOS branding (commit `ae4d7df`)

* **Table tabs:**
  * The table bar collapses tabs that don't fit into an overflow menu (`tab-fit.ts`, with unit tests).
  * Tabs have context menus and floating popovers (`floating.tsx`).
  * Each user can hide tables for themselves (`0061_user_hidden_tables.sql`, `table-prefs-routes.ts`).
* **Views sidebar:** create a view in one click from the type list.
* **Record ID criterion** like Airtable's:
  * a `record_id` field type (`0063_record_id_field.sql`, `packages/fields`, `field-ui`);
  * the virtual `__record_id__` filter in the evaluator and SQL compiler;
  * shown in the filter builder.
* **Import:** CSV/XLSX import no longer fails with "Failed to fetch". Import requests now bypass idempotency storage, and the client retries transient failures (`http/app.ts`, `idempotency.ts`, `ImportWizard.tsx`, `lib/api.ts`).
* **Rebrand from Tabula to TableOS** across the web app, public app, emails, OpenAPI title and README.

## Round 2: audit and fix pass (commits `0f31f5e` → `eb98bf1`)

A full audit (`docs/fix-plan/audit-ui.md`, `audit-backend.md`, `audit-contract.md`, with cross-workstream contracts in `CONTRACTS.md`) was followed by fixes across every area.

* **Query engine:**
  * type-aware filters, typed sort and pagination, a record serializer;
  * `fld_` id resolution;
  * 422 errors for bad ids and filters;
  * fixed a group-query 500.
* **Lookups:** filter, sort, search and group by display text.
* **Compute:**
  * stores link-lookup ids and refreshes them when a linked record is renamed;
  * schema integration tests.
* **Grid:**
  * editing fixes, typed dates, menus and popovers;
  * server summary totals and read-only mode for viewers;
  * role-based edits, uploads outside the grid;
  * 10k-row scrolling;
  * row numbers that follow view order.
* **Views:**
  * edit permissions by role, save on unload, retry after load errors;
  * kanban, timeline and form fixes;
  * calendar multi-day bars with move and resize.
* **Record history:** a revision history endpoint and an activity panel.
* **Platform:**
  * sharing and the public app, attachments, import/export, search (primary-field titles, live index sync, a reindex endpoint), notifications, contacts, comments;
  * automations triggered by real events, with lookup conditions;
  * auth, MFA, invites and billing;
  * a permissions sweep and an idempotency fix;
  * account and invite routes.
* **Dev experience:**
  * an isolated dev launcher on ports 3200/3202/5283/5284;
  * the worker and relay load `.env`;
  * fixed the web build and order-key collation;
  * favicons.

## Round 1: baseline

The initial monorepo snapshot. The reconciled architecture document set (`docs/architecture/`, 35 documents) was added on top of it.

---

## Known gaps / next steps

* Interfaces: interface-only users and share links, per-interface permissions, page-record context, drag/resize layout, aggregate caching and realtime refresh (architecture 13 §18).
* Error-code union in `@tabula/types` only lists generic codes; module codes (`PAGE_REVISION_CONFLICT`, `RECORD_ID_REQUIRED`, …) are compared as strings in the web client.
* Test interfaces and records created by the verification scripts live in the dev database (`tabula_cc`) only.
