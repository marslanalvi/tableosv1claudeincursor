import { createContext, useContext, type ReactNode } from "react";
import { FIELD_TYPES } from "@tabula/field-ui";
import s from "./help.module.css";

export interface HelpTopic {
  id: string;
  group: string;
  title: string;
  summary: string;
  keywords: string;
  body: () => ReactNode;
}

export const HelpNavContext = createContext<(topic: string) => void>(() => undefined);

function To({ topic, children }: { topic: string; children: ReactNode }) {
  const go = useContext(HelpNavContext);
  return (
    <button type="button" className={s.link} onClick={() => go(topic)}>
      {children}
    </button>
  );
}

const K = ({ children }: { children: ReactNode }) => <kbd className={s.kbd}>{children}</kbd>;
const Note = ({ children }: { children: ReactNode }) => <div className={s.note}>{children}</div>;
const Warn = ({ children }: { children: ReactNode }) => <div className={s.warn}>{children}</div>;
const Pre = ({ children }: { children: string }) => <pre className={s.pre}>{children}</pre>;

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <table className={s.table}>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const origin = typeof window !== "undefined" ? window.location.origin : "https://your-tableos-host";

const GROUP_LABEL: Record<string, string> = {
  basic: "Basic",
  advanced: "Advanced",
  computed: "Computed (read-only)",
  meta: "Record information (read-only)",
};

export const HELP_TOPICS: HelpTopic[] = [
  /* ---------------------------------------------------------------- Getting started */
  {
    id: "getting-started",
    group: "Getting started",
    title: "Welcome to TableOS",
    summary: "How workspaces, bases, tables, fields, records and views fit together.",
    keywords: "overview introduction basics start workspace base table",
    body: () => (
      <>
        <h2>The building blocks</h2>
        <Table
          head={["Thing", "What it is", "Example"]}
          rows={[
            ["Workspace", "A group of bases shared with the same people. Your organization owns its workspaces.", "Marketing"],
            ["Base", "A database for one project or process. It holds one or more tables.", "Content calendar"],
            ["Table", "A list of one kind of thing, like a spreadsheet tab.", "Articles, Authors"],
            ["Field", "A column. Every field has a type such as text, date or link.", "Title, Publish date"],
            ["Record", "A row. One record is one item in the table.", "“How to plan a launch”"],
            ["View", "A saved way of looking at a table: filters, sorts, hidden fields, layout.", "“Published this month” (grid)"],
          ]}
        />
        <h2>Quick start</h2>
        <ol>
          <li>On the home page, choose <b>Create base</b>. A base starts with one table called “Table 1”.</li>
          <li>Rename the first column and add fields with the <b>+</b> at the end of the header row (see <To topic="fields">Fields</To>).</li>
          <li>Type straight into cells, or <To topic="import-export">import a CSV or Excel file</To>.</li>
          <li>Add more tables with the <b>+</b> next to the table tabs, and connect them with <To topic="linking">link fields</To>.</li>
          <li>Create <To topic="views">views</To> for the ways your team looks at the data.</li>
          <li>Ask the owner to <To topic="access">invite your colleagues</To>.</li>
        </ol>
        <h2>Popular topics</h2>
        <div className={s.cards}>
          {[
            ["access", "Members, roles & privileges", "Who can see and change what."],
            ["cross-base", "Use data from another base", "Synced tables and cross-base links."],
            ["api", "API & access tokens", "Read and write records from your own code."],
            ["ids", "Base, table and record IDs", "Where to find them and how they work."],
          ].map(([id, title, text]) => (
            <TopicCard key={id} id={id!} title={title!} text={text!} />
          ))}
        </div>
      </>
    ),
  },
  {
    id: "ids",
    group: "Getting started",
    title: "IDs: bases, tables, fields and records",
    summary: "Every object has a permanent, globally unique ID that you can copy and use in the API.",
    keywords: "id identifier table id base id record id field id unique tbl_ bas_ rec_ fld_ copy",
    body: () => (
      <>
        <p>
          Every base, table, field, record and view has an ID that never changes, even if you rename it. IDs are unique across{" "}
          <b>all</b> bases and workspaces, so a table ID always points to exactly one table.
        </p>
        <Table
          head={["Object", "Looks like", "Where to copy it"]}
          rows={[
            ["Base", <code>bas_…</code>, "Table tab menu → IDs & API…"],
            ["Table", <code>tbl_…</code>, "Table tab menu → IDs & API…"],
            ["Field", <code>fld_…</code>, "Field header menu → Copy field ID, or IDs & API…"],
            ["Record", <code>rec_…</code>, "Expanded record → ⋯ → Copy record ID, or add a Record ID field"],
            ["View", <code>viw_…</code>, "The URL while the view is open"],
          ]}
        />
        <h3>The Record ID field</h3>
        <p>
          New tables include a <b>Record ID</b> field that shows each record’s <code>rec_…</code> ID. It is hidden in new views by default; show it
          from <b>Hide fields</b> in the view toolbar when you need it. You can also use <code>RECORD_ID()</code> in a formula.
        </p>
        <Note>
          The API accepts a table ID on its own (<code>/v1/tables/tbl_…/records</code>), so you don’t need to look up the base ID. See{" "}
          <To topic="api">API reference</To>.
        </Note>
      </>
    ),
  },

  /* ---------------------------------------------------------------- Building */
  {
    id: "fields",
    group: "Building your base",
    title: "Fields and field types",
    summary: "Every field type, what it stores, and how to add, edit, hide or delete fields.",
    keywords: "field column type text number date select link attachment formula lookup rollup add edit delete primary",
    body: () => {
      const groups = ["basic", "advanced", "computed", "meta"];
      return (
        <>
          <h2>Working with fields</h2>
          <ul>
            <li><b>Add a field:</b> click <b>+</b> at the end of the header row, pick a type and give it a name.</li>
            <li><b>Edit, duplicate, insert left/right, sort, filter, group, freeze or hide:</b> click the ▾ on a field header (or right-click it).</li>
            <li><b>Reorder:</b> drag a header. <b>Resize:</b> drag the header’s right edge.</li>
            <li>
              <b>Primary field:</b> the first column names each record (in links, cards and search). It can’t be hidden or deleted, but you
              can change its type.
            </li>
            <li><b>Change a type:</b> TableOS converts existing values where it can. Changes can be undone with <K>Ctrl</K>+<K>Z</K>.</li>
            <li><b>Description:</b> add one in the field dialog; it appears as a tooltip on the header.</li>
          </ul>
          <h2>Field types</h2>
          {groups.map((g) => (
            <div key={g}>
              <h3>{GROUP_LABEL[g]}</h3>
              <Table
                head={["Type", "Description"]}
                rows={FIELD_TYPES.filter((t) => t.group === g).map((t) => [
                  <span>
                    {t.icon} {t.label}
                  </span>,
                  t.description,
                ])}
              />
            </div>
          ))}
          <Note>
            Computed and record-information fields can’t be typed into: their values come from other fields or from TableOS. Fields in a{" "}
            <To topic="cross-base">synced table</To> are read-only too.
          </Note>
        </>
      );
    },
  },
  {
    id: "records",
    group: "Building your base",
    title: "Editing records",
    summary: "Typing in cells, expanding records, comments, history, duplicating, deleting and undo.",
    keywords: "record row edit cell expand drawer comment mention history duplicate delete undo redo trash restore fill copy paste",
    body: () => (
      <>
        <h2>In the grid</h2>
        <ul>
          <li>Click a cell and start typing to replace its value, or press <K>Enter</K> to edit it.</li>
          <li>Select a range by dragging or with <K>Shift</K>+arrows; copy and paste with <K>Ctrl</K>+<K>C</K> / <K>Ctrl</K>+<K>V</K>, including from Excel or Google Sheets.</li>
          <li>Drag the small handle at the bottom-right of a selection to fill values down.</li>
          <li>Add a record with the <b>+</b> row at the bottom, or right-click a row to insert above/below, duplicate or delete.</li>
          <li>Tick the row checkboxes to act on several records at once.</li>
        </ul>
        <h2>The expanded record</h2>
        <p>
          Click the ⤢ icon at the start of a row (or press <K>Space</K>) to open the record. There you can edit every field, including hidden
          ones, and:
        </p>
        <ul>
          <li><b>Comment</b> and @mention collaborators, who are notified.</li>
          <li>See the <b>revision history</b>: who changed what and when.</li>
          <li>Use ⋯ to copy the record URL or ID, duplicate or delete it.</li>
          <li>Move between records with <K>↑</K>/<K>↓</K> (or <K>K</K>/<K>J</K>) and close with <K>Esc</K>.</li>
        </ul>
        <h2>Undo and trash</h2>
        <p>
          <K>Ctrl</K>+<K>Z</K> undoes your last change in this base and <K>Ctrl</K>+<K>Shift</K>+<K>Z</K> (or <K>Ctrl</K>+<K>Y</K>) redoes it. Deleted
          tables, fields and records can be restored from the base’s <b>Trash</b>.
        </p>
      </>
    ),
  },
  {
    id: "views",
    group: "Building your base",
    title: "Views",
    summary: "Grid, Gallery, Kanban, Calendar, Timeline, List, Gantt and Form views, and the view toolbar.",
    keywords: "view grid gallery kanban calendar timeline list gantt form filter sort group hide fields row height color toolbar",
    body: () => (
      <>
        <p>
          A view is a saved way of looking at a table. Every table can have many views; changing a view (filters, sorting, hidden fields) never
          changes the data. Open the views list from the left of the toolbar.
        </p>
        <Table
          head={["View", "Best for"]}
          rows={[
            ["▦ Grid", "Spreadsheet-style editing of many records."],
            ["▣ Gallery", "Cards with a cover image, e.g. products or people."],
            ["▥ Kanban", "Cards in columns by a single-select or user field; drag to change status."],
            ["31 Calendar", "Records placed on a date field."],
            ["═ Timeline", "Records as bars between a start and end date."],
            ["╤ Gantt", "Project schedules with start/end dates."],
            ["☰ List", "A compact, readable list."],
            ["▤ Form", "A form anyone with the link can fill in to add records (see Forms)."],
          ]}
        />
        <h2>The view toolbar</h2>
        <ul>
          <li><b>Hide fields</b>: choose which fields this view shows. New views hide the Record ID field.</li>
          <li><b>Filter</b>: show only records that match conditions; combine them with “and” / “or” groups.</li>
          <li><b>Group</b>: group records by up to three fields, with summaries per group.</li>
          <li><b>Sort</b>: order by one or more fields.</li>
          <li><b>Color</b>: color rows by a select field or by conditions.</li>
          <li><b>Row height</b>: short, medium, tall or extra tall.</li>
          <li><b>Search</b> (🔍): find text in this view.</li>
          <li><b>Share view</b>: create a read-only public link (see <To topic="sharing">Sharing</To>).</li>
        </ul>
        <p>
          The footer of a grid view shows a summary per column (count, sum, average, min, max, filled, empty…). Click it to choose.
        </p>
      </>
    ),
  },
  {
    id: "linking",
    group: "Building your base",
    title: "Linking tables: links, lookups and rollups",
    summary: "Connect records between tables and pull values across with lookup, rollup and count fields.",
    keywords: "link linked record relationship lookup rollup count relation foreign key",
    body: () => (
      <>
        <h2>Link to another record</h2>
        <p>
          A <b>Link to another record</b> field connects records in one table to records in another, for example each Article to its Author.
          TableOS adds a matching link field to the other table automatically, so you can see the relationship from both sides.
        </p>
        <ul>
          <li>Click a link cell and pick records, or type to search. Turn off “allow multiple” to allow just one.</li>
          <li>Linked records appear as chips; click a chip to open that record.</li>
        </ul>
        <h2>Using linked data</h2>
        <Table
          head={["Field", "What it does", "Example"]}
          rows={[
            ["Lookup", "Shows a field from the linked records.", "Author → Email"],
            ["Rollup", "Summarizes a field across linked records (sum, average, min, max, count, join…).", "Order lines → SUM(Amount)"],
            ["Count", "Counts linked records.", "Number of articles per author"],
          ]}
        />
        <Note>
          The linked table can live in another base. Choose <b>Link to a table in another base</b> when creating a link field. See{" "}
          <To topic="cross-base">Data from other bases</To>.
        </Note>
      </>
    ),
  },
  {
    id: "cross-base",
    group: "Building your base",
    title: "Data from other bases (synced tables)",
    summary: "Bring another base’s table into this base, kept up to date automatically, and link to it.",
    keywords: "cross base sync synced table link another base share data between bases mirror lookup",
    body: () => (
      <>
        <p>
          Bases in the same organization can use each other’s data. TableOS does this with <b>synced tables</b>: a read-only copy of a table
          from another base that stays up to date automatically. Because it is a normal table in your base, you can link to it and use lookups,
          rollups, filters and formulas with it.
        </p>
        <h2>Add a synced table</h2>
        <ol>
          <li>Click <b>+</b> next to the table tabs and choose <b>Sync from another base</b> (or choose it in the “Add a table” dialog).</li>
          <li>Pick the base and table. You only see bases you can read.</li>
          <li>TableOS copies the fields and records. The tab shows a ⇄ badge.</li>
        </ol>
        <h2>Link to a table in another base</h2>
        <p>
          When you create a <b>Link to another record</b> field, choose <b>+ Link to a table in another base</b>. TableOS adds a synced copy of that
          table (or reuses one that already exists) and links to it, so a lookup or rollup can bring in any of its fields.
        </p>
        <h2>How syncing works</h2>
        <ul>
          <li>Changes in the source table arrive within a few seconds. A full check also runs every few minutes (5 by default).</li>
          <li>Field renames, new fields, type changes and deleted fields are copied too.</li>
          <li>The bar above a synced table shows when it last synced. Use <b>Sync now</b>, <b>Pause</b> or <b>Resume</b> there or in the tab menu.</li>
          <li>
            Synced fields and records are read-only, and you can’t add or delete records. You <b>can</b> add your own fields (notes, links, formulas)
            to a synced table; those stay editable.
          </li>
          <li>
            <b>Stop syncing</b> (tab menu) keeps the table and its data as a normal, editable table that is no longer updated.
          </li>
        </ul>
        <Warn>
          A sync runs with the access of the person who created it. If that person loses access to the source base, the sync stops with an error until
          someone with access sets it up again.
        </Warn>
      </>
    ),
  },
  {
    id: "formulas",
    group: "Building your base",
    title: "Formulas",
    summary: "Write formulas that compute values from other fields, with a list of functions.",
    keywords: "formula function expression IF SUM CONCATENATE DATEADD DATETIME_DIFF calculate compute",
    body: () => (
      <>
        <p>
          A formula field computes its value from other fields in the same record. Refer to a field by its name in braces, for example{" "}
          <code>{"{Price} * {Quantity}"}</code>. The editor suggests field and function names as you type.
        </p>
        <h2>Operators</h2>
        <Table
          head={["Operator", "Meaning"]}
          rows={[
            [<code>+ - * /</code>, "Arithmetic"],
            [<code>&amp;</code>, "Join text: {First} & \" \" & {Last}"],
            [<code>= != &lt; &gt; &lt;= &gt;=</code>, "Comparison"],
            [<code>&amp;&amp; ||</code>, "Logical and / or (or use AND(), OR())"],
          ]}
        />
        <h2>Functions</h2>
        <Table
          head={["Group", "Functions"]}
          rows={[
            ["Logic", "IF, SWITCH, AND, OR, XOR, NOT, BLANK, ISBLANK, ISERROR, IFERROR, ERROR, TRUE, FALSE"],
            ["Numbers", "SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTALL, ROUND, ROUNDUP, ROUNDDOWN, FLOOR, CEILING, INT, TRUNC, MOD, POWER, SQRT, EXP, LOG, LN, ABS, SIGN, EVEN, ODD, VALUE"],
            ["Text", "CONCATENATE, CONCAT, LEFT, RIGHT, MID, LEN, LOWER, UPPER, PROPER, TRIM, FIND, SEARCH, SUBSTITUTE, REPLACE, REPT, SPLIT, TEXT, CONTAINS, ENCODE_URL_COMPONENT, REGEX_MATCH, REGEX_TEST, REGEX_EXTRACT, REGEX_EXTRACT_ALL, REGEX_REPLACE"],
            ["Dates", "TODAY, NOW, DATEADD, DATETIME_DIFF, DATETIME_FORMAT, DATETIME_PARSE, DATESTR, TIMESTR, YEAR, MONTH, DAY, HOUR, MINUTE, SECOND, WEEKDAY, WEEKNUM, WORKDAY, WORKDAY_DIFF, IS_BEFORE, IS_AFTER, IS_SAME, SET_TIMEZONE, SET_LOCALE, TONOW, FROMNOW, DATE_TRUNC"],
            ["Lists", "ARRAYJOIN, ARRAYUNIQUE, ARRAYCOMPACT, ARRAYFLATTEN, ARRAYSLICE, ARRAY_FIRST, ARRAY_LAST, ARRAY_SORT, ARRAY_CONTAINS"],
            ["Record", "RECORD_ID, CREATED_TIME, LAST_MODIFIED_TIME, CREATED_BY, MODIFIED_BY, ROW_NUMBER, JSON_GET"],
          ]}
        />
        <h2>Examples</h2>
        <Pre>{`IF({Due date} < TODAY(), "Overdue", "On track")
DATETIME_DIFF({End}, {Start}, "days")
UPPER(LEFT({Name}, 1)) & LOWER(MID({Name}, 2, 100))
ROUND({Amount} * 1.2, 2)`}</Pre>
      </>
    ),
  },
  {
    id: "import-export",
    group: "Building your base",
    title: "Import and export",
    summary: "Bring in CSV, TSV or Excel files; download a view as CSV, Excel or JSON.",
    keywords: "import export csv excel xlsx tsv json download upload spreadsheet",
    body: () => (
      <>
        <h2>Import</h2>
        <ol>
          <li>Click <b>+</b> next to the table tabs and choose <b>Import a file</b>, or use <b>Import</b> from the table menu to add rows to an existing table.</li>
          <li>Choose a <code>.csv</code>, <code>.tsv</code>, <code>.txt</code> or <code>.xlsx</code> file. For Excel, pick the sheet.</li>
          <li>Check the preview: TableOS suggests a field type for each column. Change types or skip columns as needed.</li>
          <li>Import. Large files are imported in the background.</li>
        </ol>
        <h2>Export</h2>
        <p>
          Use <b>Download</b> from the view menu to export the records visible in the current view, in view order, as CSV, Excel (.xlsx) or JSON.
          Hidden fields and filtered-out records are left out.
        </p>
      </>
    ),
  },

  /* ---------------------------------------------------------------- Collaboration */
  {
    id: "forms",
    group: "Collaboration",
    title: "Forms",
    summary: "Collect records from anyone with a form view.",
    keywords: "form survey submission public collect",
    body: () => (
      <>
        <p>
          A form view turns a table into a form. Create one from the views list (<b>Create a view → Form</b>), choose which fields appear, mark
          required fields and add help text. Share the form link; each submission becomes a new record.
        </p>
        <p>
          You can run an automation when a form is submitted (see <To topic="automations">Automations</To>).
        </p>
      </>
    ),
  },
  {
    id: "interfaces",
    group: "Collaboration",
    title: "Interfaces",
    summary: "Build simple app-like pages on top of your data.",
    keywords: "interface page dashboard app designer elements",
    body: () => (
      <>
        <p>
          Interfaces are pages built from your base’s data, such as dashboards, record lists and detail pages, for people who don’t need the full grid.
          Open <b>Interfaces</b> from the top of a base to create or edit one, then add elements and connect each to a table or view.
        </p>
        <p>
          People with the <b>Interface only</b> role on a base can use its interfaces but can’t open the tables directly. See{" "}
          <To topic="access">Members, roles &amp; privileges</To>.
        </p>
      </>
    ),
  },
  {
    id: "automations",
    group: "Collaboration",
    title: "Automations",
    summary: "Run actions automatically when records change, on a schedule or from a webhook.",
    keywords: "automation trigger action workflow webhook email notify schedule run history",
    body: () => (
      <>
        <p>
          Open <b>Automations</b> from the top of a base. An automation has one trigger and one or more actions. Insert values from the trigger record
          into actions with the <b>{"{}"}</b> token picker.
        </p>
        <Table
          head={["Triggers", "Actions"]}
          rows={[
            ["When a record is created", "Update record"],
            ["When a record is updated (optionally for specific fields)", "Create record"],
            ["When a record matches conditions", "Find records"],
            ["When a record enters a view", "Delete record"],
            ["When a form is submitted", "Send in-app notification"],
            ["At a scheduled time", "Send email"],
            ["When a button is clicked", "Send webhook"],
            ["When a webhook is received", "Conditional group (run actions only if conditions are met)"],
          ]}
        />
        <p>Use <b>Test</b> to try an automation, and the run history to see what happened and why something failed.</p>
      </>
    ),
  },
  {
    id: "sharing",
    group: "Collaboration",
    title: "Sharing links",
    summary: "Share a read-only view or form with people outside TableOS.",
    keywords: "share link public password expiration embed read only",
    body: () => (
      <>
        <p>
          Choose <b>Share view</b> in the toolbar to create a public link to a view. Anyone with the link can see the records in that view (read-only),
          without signing in. Options:
        </p>
        <ul>
          <li><b>Password protection</b>: visitors must enter a password.</li>
          <li><b>Expiration date</b>: the link stops working afterwards.</li>
          <li><b>Allow copying data</b>: lets visitors copy or download records.</li>
        </ul>
        <p>Turn the link off at any time to stop sharing. To give someone access they can sign in with, ask the owner to invite them.</p>
      </>
    ),
  },
  {
    id: "search-notifications",
    group: "Collaboration",
    title: "Search, notifications and contacts",
    summary: "Find anything quickly, stay on top of mentions, and keep a contact list.",
    keywords: "search palette find notifications bell mentions contacts",
    body: () => (
      <>
        <h2>Search</h2>
        <p>
          Press <K>Ctrl</K>+<K>K</K> (<K>⌘</K>+<K>K</K> on Mac) anywhere to search bases, tables and records. Use <K>↑</K>/<K>↓</K> and{" "}
          <K>Enter</K> to open a result.
        </p>
        <h2>Notifications</h2>
        <p>The bell shows mentions, comments on your records, automation messages and invitations. Click one to go to the record.</p>
        <h2>Contacts</h2>
        <p>Each workspace has a contact list you can use in user fields and automations. Open it from the workspace’s ⋯ menu on the home page.</p>
      </>
    ),
  },

  /* ---------------------------------------------------------------- Admin & security */
  {
    id: "access",
    group: "Admin & security",
    title: "Members, roles & privileges",
    summary: "Only the owner invites people and decides what each person can do, per workspace or per base.",
    keywords: "members roles privileges permissions owner creator editor commenter viewer read only interface invite remove suspend access expire",
    body: () => (
      <>
        <p>
          Each organization has one <b>owner</b>. Only the owner can invite people, change roles, set access end dates, approve devices and create
          API tokens. Everyone else sees what they’ve been given access to and nothing more. Open <b>Members &amp; access</b> from the account menu.
        </p>
        <h2>Roles</h2>
        <Table
          head={["Role", "Can do"]}
          rows={[
            ["Owner", "Everything, including managing members, devices, API tokens and security settings. There is one owner per organization."],
            ["Creator", "Everything in the base: tables, fields, views, automations, interfaces, sharing, plus all record changes."],
            ["Editor", "Add, edit and delete records; create and edit views. Can’t change tables or fields."],
            ["Commenter", "Read everything and comment on records."],
            ["Read only", "Read records and views. Can’t change anything."],
            ["Interface only (base)", "Use the base’s interfaces only; the tables themselves stay hidden."],
            ["No access", "Can’t see the workspace or base at all."],
          ]}
        />
        <h2>Workspace and base access</h2>
        <ul>
          <li>A <b>workspace role</b> applies to every base in the workspace.</li>
          <li>A <b>base role</b> applies to one base. Use it to give someone access to a single base, or a different role in it.</li>
          <li>When both apply, the person gets the higher of the two.</li>
          <li>Set <b>Access until</b> on any role to have it end automatically on that date.</li>
        </ul>
        <h2>Inviting people</h2>
        <ol>
          <li>Open <b>Members &amp; access → People</b>.</li>
          <li>Enter an email, choose a workspace or a single base and a role, and send the invitation.</li>
          <li>If email isn’t set up, copy the invite link and send it yourself. Pending invitations can be cancelled.</li>
        </ol>
        <h2>Changing or removing access</h2>
        <ul>
          <li>Change any role in the member’s access table; choose “No access” to remove it from that workspace or base.</li>
          <li><b>Suspend</b> blocks a person immediately while keeping their settings; <b>Reactivate</b> restores them.</li>
          <li><b>Remove</b> takes away all of their access in the organization and signs out their devices.</li>
        </ul>
        <Note>Changes apply immediately, including to people who are signed in right now.</Note>
      </>
    ),
  },
  {
    id: "devices",
    group: "Admin & security",
    title: "Device approval",
    summary: "Limit access to devices the owner has approved.",
    keywords: "device approval mac address computer laptop restrict trusted approve revoke security",
    body: () => (
      <>
        <p>
          With device approval on, members can only use TableOS from devices the owner has approved. This replaces restricting access by MAC address:
          web browsers can’t read a computer’s MAC address, so TableOS registers each browser as a named device instead.
        </p>
        <h2>Turning it on or off</h2>
        <p>
          Device approval is on by default. The owner can change it in <b>Members &amp; access → Security → Require device approval</b>. The owner’s
          own devices are always allowed, so you can’t lock yourself out.
        </p>
        <h2>What members see</h2>
        <ol>
          <li>A member signs in on a new device. TableOS registers it and shows “Waiting for the owner to approve this device”.</li>
          <li>Until it is approved, they can’t see any data in that organization.</li>
          <li>Once the owner approves it, the page unlocks automatically.</li>
        </ol>
        <h2>Managing devices</h2>
        <p>
          In <b>Members &amp; access → Devices</b> the owner sees pending devices (with browser, system, IP address and when they were last seen) and
          can <b>Approve</b>, <b>Deny</b>, <b>Revoke</b> a previously approved device, <b>rename</b> it (e.g. “Front desk PC”) or <b>forget</b> it.
        </p>
        <Warn>
          A device is one browser on one computer. Clearing browser data or using another browser counts as a new device that needs approval.
        </Warn>
      </>
    ),
  },
  {
    id: "account",
    group: "Admin & security",
    title: "Your account and two-factor authentication",
    summary: "Change your name, email or password, turn on 2FA and sign out other sessions.",
    keywords: "account profile password two-factor 2fa totp authenticator sessions sign out",
    body: () => (
      <>
        <p>Open <b>Account settings</b> from the account menu (your avatar).</p>
        <ul>
          <li><b>Profile</b>: your name and email.</li>
          <li><b>Password</b>: changing it signs you out of your other sessions.</li>
          <li>
            <b>Two-factor authentication</b>: scan the QR code with an authenticator app, then enter a code each time you sign in. Keep the
            recovery codes somewhere safe.
          </li>
          <li><b>Sessions</b>: see where you’re signed in and sign out of the others.</li>
        </ul>
      </>
    ),
  },

  /* ---------------------------------------------------------------- Developers */
  {
    id: "api-tokens",
    group: "Developers",
    title: "API access tokens",
    summary: "The owner creates tokens with read, write or delete permission, for all or chosen bases.",
    keywords: "api token access token personal access token bearer read write delete scope generate revoke",
    body: () => (
      <>
        <p>
          Programs use an access token to call the <To topic="api">TableOS API</To>. Only the owner can create tokens, in{" "}
          <b>Members &amp; access → API tokens</b>.
        </p>
        <h2>Creating a token</h2>
        <ol>
          <li>Give it a name that says what uses it, e.g. “Website orders sync”.</li>
          <li>
            Choose its <b>token types</b> (you can combine them):
            <Table
              head={["Type", "Allows"]}
              rows={[
                ["Read", "List and query records, read one record, read base and table schemas."],
                ["Write", "Create and update records, and link or unlink records."],
                ["Delete", "Delete records."],
              ]}
            />
          </li>
          <li>Choose <b>All bases</b> or pick specific bases, and optionally an expiry date.</li>
          <li>Copy the token right away: it is shown only once. TableOS stores only a fingerprint of it.</li>
        </ol>
        <Warn>
          Treat a token like a password. Anyone who has it can do what the token allows. If one leaks, <b>Revoke</b> it straight away; it stops working
          immediately.
        </Warn>
        <p>The token list shows each token’s types, bases, expiry and when it was last used.</p>
      </>
    ),
  },
  {
    id: "api",
    group: "Developers",
    title: "API reference",
    summary: "Record endpoints that accept a table ID (or base and table ID), with examples.",
    keywords: "api rest endpoint http curl json records query create update delete batch pagination filter sort table id base id",
    body: () => (
      <>
        <p>
          Every request needs an <To topic="api-tokens">access token</To> in the <code>Authorization</code> header. Requests and responses are JSON.
        </p>
        <Pre>{`Authorization: Bearer tos_…
Content-Type: application/json`}</Pre>
        <h2>Addressing a table</h2>
        <p>
          Use either the table ID on its own, or the base ID and table ID. Both are permanent; find them in the table tab menu under{" "}
          <b>IDs &amp; API…</b> (see <To topic="ids">IDs</To>).
        </p>
        <Pre>{`${origin}/v1/tables/{tableId}/records…
${origin}/v1/bases/{baseId}/tables/{tableId}/records…`}</Pre>
        <h2>Endpoints</h2>
        <Table
          head={["Method and path", "Token type", "What it does"]}
          rows={[
            [<code>GET /v1/api/bases</code>, "read", "Bases the token can reach, with their tables and IDs."],
            [<code>GET /v1/bases/{"{baseId}"}</code>, "read", "A base’s tables and fields (schema)."],
            [<code>GET /v1/tables/{"{tableId}"}</code>, "read", "One table and its fields."],
            [<code>POST …/records/query</code>, "read", "List records with filter, sort, search, paging."],
            [<code>GET …/records/{"{recordId}"}</code>, "read", "One record. Optional ?fields=fld_a,fld_b"],
            [<code>POST …/records/group</code>, "read", "Grouped counts and aggregates."],
            [<code>POST …/records</code>, "write", "Create one record."],
            [<code>POST …/records/batch</code>, "write", "Create up to 500 records."],
            [<code>PATCH …/records/{"{recordId}"}</code>, "write", "Update some fields of one record."],
            [<code>PATCH …/records/batch</code>, "write", "Update up to 500 records."],
            [<code>DELETE …/records/{"{recordId}"}</code>, "delete", "Delete one record."],
            [<code>POST …/records/batch-delete</code>, "delete", "Delete up to 500 records."],
          ]}
        />
        <h2>Fields in requests</h2>
        <p>
          In <code>fields</code>, use field IDs (<code>fld_…</code>, recommended because they survive renames) or field names. Responses always use
          field IDs. Set <code>"typecast": true</code> to let TableOS convert values, e.g. a select option name into the option.
        </p>
        <h2>Examples</h2>
        <h3>List records</h3>
        <Pre>{`curl -X POST "${origin}/v1/tables/tbl_…/records/query" \\
  -H "Authorization: Bearer $TABLEOS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "pageSize": 100,
    "sort": [{ "fieldId": "fld_…", "direction": "desc" }],
    "filter": { "kind": "condition", "fieldId": "fld_…", "op": "gte", "value": 10 }
  }'`}</Pre>
        <p>
          The response is <code>{`{ "records": [{ "id": "rec_…", "fields": { "fld_…": … } }], "nextCursor": "…" }`}</code>. Pass{" "}
          <code>nextCursor</code> back as <code>cursor</code> to get the next page; it is <code>null</code> on the last page. Use{" "}
          <code>"viewId": "viw_…"</code> to apply a view’s filters and sorting, <code>"search"</code> for text search and <code>"fields"</code> to limit
          the fields returned.
        </p>
        <p>
          Filters combine with <code>{`{ "kind": "and", "children": [ … ] }`}</code> or <code>"or"</code>. Condition operators include{" "}
          <code>eq</code>, <code>neq</code>, <code>contains</code>, <code>notContains</code>, <code>empty</code>, <code>notEmpty</code>, <code>gt</code>,{" "}
          <code>gte</code>, <code>lt</code> and <code>lte</code>.
        </p>
        <h3>Create records</h3>
        <Pre>{`curl -X POST "${origin}/v1/tables/tbl_…/records/batch" \\
  -H "Authorization: Bearer $TABLEOS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{ "records": [ { "fields": { "Name": "Ada", "Status": "Active" } } ], "typecast": true }'`}</Pre>
        <h3>Update a record</h3>
        <Pre>{`curl -X PATCH "${origin}/v1/tables/tbl_…/records/rec_…" \\
  -H "Authorization: Bearer $TABLEOS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{ "fields": { "fld_…": "New value" } }'`}</Pre>
        <h3>Delete records</h3>
        <Pre>{`curl -X POST "${origin}/v1/tables/tbl_…/records/batch-delete" \\
  -H "Authorization: Bearer $TABLEOS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{ "ids": ["rec_…", "rec_…"] }'`}</Pre>
        <h3>JavaScript</h3>
        <Pre>{`const res = await fetch("${origin}/v1/tables/tbl_…/records/query", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.TABLEOS_TOKEN}\`, "Content-Type": "application/json" },
  body: JSON.stringify({ pageSize: 100 }),
});
const { records, nextCursor } = await res.json();`}</Pre>
        <h2>Errors</h2>
        <Table
          head={["Status", "Meaning"]}
          rows={[
            ["400 / 422", "The request body is invalid; the response lists the problem fields."],
            ["401", "Missing, invalid, expired or revoked token."],
            ["403", "The token lacks the needed type (read/write/delete), can’t use this base, or the table is synced (read-only)."],
            ["404", "The base, table or record doesn’t exist, or the token can’t see it."],
            ["409", "The record changed since you read it (when you send a version)."],
            ["429", "Too many requests; wait and retry."],
          ]}
        />
        <Note>
          A token acts with the owner’s permissions, limited further by its token types and bases. Changes made through the API show up in record
          history as made via the API.
        </Note>
      </>
    ),
  },
  {
    id: "shortcuts",
    group: "Developers",
    title: "Keyboard shortcuts",
    summary: "Move around and edit without the mouse.",
    keywords: "keyboard shortcuts hotkeys keys navigation",
    body: () => (
      <Table
        head={["Keys", "Action"]}
        rows={[
          [<><K>Ctrl</K>+<K>K</K></>, "Search everything"],
          [<><K>Ctrl</K>+<K>Z</K></>, "Undo"],
          [<><K>Ctrl</K>+<K>Shift</K>+<K>Z</K> / <K>Ctrl</K>+<K>Y</K></>, "Redo"],
          [<><K>↑</K> <K>↓</K> <K>←</K> <K>→</K></>, "Move between cells (with Ctrl: jump to the edge)"],
          [<><K>Shift</K>+arrows</>, "Extend the selection"],
          [<><K>Tab</K> / <K>Shift</K>+<K>Tab</K></>, "Next / previous cell"],
          [<K>Enter</K>, "Edit the cell (or toggle a checkbox)"],
          ["Any character", "Start typing to replace the cell’s value"],
          [<K>Space</K>, "Expand the record"],
          [<><K>Shift</K>+<K>Space</K></>, "Select or unselect the row"],
          [<><K>Delete</K> / <K>Backspace</K></>, "Clear the selected cells"],
          [<><K>Ctrl</K>+<K>C</K> / <K>Ctrl</K>+<K>V</K></>, "Copy / paste cells"],
          [<><K>Ctrl</K>+<K>A</K></>, "Select all cells"],
          [<K>Esc</K>, "Cancel editing, clear the selection or close a dialog"],
          [<><K>↑</K>/<K>↓</K> or <K>K</K>/<K>J</K></>, "Previous / next record (in an expanded record)"],
          ["1–9", "Set a rating cell"],
        ]}
      />
    ),
  },
];

function TopicCard({ id, title, text }: { id: string; title: string; text: string }) {
  const go = useContext(HelpNavContext);
  return (
    <button type="button" className={s.card} onClick={() => go(id)}>
      <div className={s.cardTitle}>{title}</div>
      <div className={s.cardText}>{text}</div>
    </button>
  );
}
