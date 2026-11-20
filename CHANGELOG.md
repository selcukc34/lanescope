# Changelog

## [Unreleased]

### Added

- **Keyword search:** a **Search…** box in the toolbar (next to **Trace**; **Cmd/Ctrl+F** focuses it, **Escape** clears it) lists every place a word appears in the shown process in a new **Search (N)** tab: names, documentation, lanes, flow conditions, script code, what calls call and their input and output mappings ("not mapped" included), user task and timer settings, the inside of called services (steps, scripts, REST details, gateway conditions, coach controls and bindings), nodes inside sub-processes, the process's variables, inputs and outputs, and business objects and their fields. Plain case-insensitive substring of at least 2 characters (the Turkish İ and ı match i), local, no AI.
  - Results are grouped per element (kind, name, the sub-process or "Inside service" it is in), names first, then in diagram order, each row with its field and the matched text in context; at most 500 are listed. A row selects and centres its element and updates Details (opening the sub-process it is in); **Open in service** opens a called service and selects the step. Arrow keys and Enter work in the list. The diagram gets no extra marks.
  - With `lanescope.showScripts` off, scripts are not searched (not sent to the view at all) and the tab says so. Only the shown process is searched; other BPDs of a `.twx` are not. The query is kept per editor and runs again after a live refresh or a toggle; exports are not affected.
- **Description traceability:** a new **Trace** tab checks the shown process against the Markdown description it was built from (for example Bob's `<name>-description.md`) and lists, row by row, what is found exactly (✓), a near match (≈, e.g. "matched as 'Validate Order SF'"), missing (✗), unchecked (?) and extra in the process (+). Steps, gateway paths, business object fields and human task fields are compared by name; the logic of the process is not checked. No AI, no network.
  - The summary counts what the process can answer: "24 of 24 checkable items found (19 exact, 5 near) · 0 missing · 17 unchecked · 1 extra". The tab title counts missing items only ("Trace (2)").
  - A description next to the opened file (`<name>-description.md` or `<name>.md`) is attached automatically; the setting `lanescope.trace.autoDetectDescription` (default `true`) turns this off.
  - **Lanescope: Check Against Description…** picks a description and opens the tab; **Lanescope: Clear Description Check** or **Clear** in the tab removes it. The choice is remembered per file; the description is watched and the check runs again when it or the process changes.
  - A row selects its node or flow (opening the sub-process it is in) and shows its details. The diagram is not marked; the comparison, the warnings and the exports are not affected.
- **Lanescope description format:** the README defines the format the check reads: `## Main process steps` (required), `## Gateway paths` ("after &lt;step&gt;" in a sentence, or one `### After <step>` per gateway), `## Business object` (`<Name>:` or `### <Name>`, several allowed) and `## Human tasks` (`### <task>`). Every other heading is free text. A description with none of these sections shows one notice line instead of rows. The README also has a paragraph to add to a prompt that asks IBM Bob to write the description in this format.
- **Trace button** in the diagram's toolbar: **Trace** opens the Trace tab, or asks for a description when none is attached; a badge counts the missing items and the tooltip names the description. **▾** holds **Check Against Description…**, **Open Process Description** (or **New Process Description** while the file is not there) and **Clear Description Check** (enabled while a description is attached), the same commands as the Command Palette and the editor's **…** menu. The menu works from the keyboard (Enter, Space, arrows, Home, End, Escape) and closes on a click outside. Not in exports.
- **Lanescope: New or Open Process Description** (Command Palette, editor **…** menu): opens `<name>-description.md` next to the opened file beside the diagram and attaches it, writing it from a fixed template first when it is not there. An existing file is opened as it is, without a question, and never written.

### Fixed

- **The selected element is highlighted.** A click on a node, flow or lane, a row of the Changes or Trace tab, the selection kept over a redraw and the one brought back after opening a level all draw the selected element the same way: a thicker border in the theme's focus colour with a glow (a lane or pool with a dashed border, no glow). A diff mark keeps its colour under it. Before, the selection was only a faint shadow. Exports do not include it.
- **No frame around the whole diagram on a click.** Clicking the diagram focused its SVG, and the webview's focus style drew a frame around the whole diagram. The frame is gone; a keyboard user still gets a thin one.
- **DOCTYPE rejections are explained.** A document with a DOCTYPE is still never parsed, but the reason is no longer lost:
  - When nothing can be shown because of it (the only BPD of a `.twx`, a `.bpmn` file, or the `.bpmn` inside a zip), the error says so: `Lanescope could not open this file: <name> contains a DOCTYPE declaration, which is rejected for security reasons (XML entity expansion). Export the process again without a DOCTYPE.` More than one rejected BPD is shown as `<first> and N more`. Before, a `.twx` showed the generic "does not contain a business process definition" error.
  - When the file still opens, the Warnings tab has one line that lists what was skipped: `N objects were skipped because they contain a DOCTYPE declaration (rejected for security reasons): …` for `.twx` objects, and the same for `.xsd` files, whose business objects are then missing.
  - Messages name objects (by their package.xml name and path) or files only, never their content.

### Internal

- Tests: in-memory tests for the DOCTYPE messages (TWX with one or two BPDs, `.bpmn`, `.bpmn` and `.xsd` in a zip). Without `test/fixtures/local/` the suite passes with the tests that need real exports skipped.

## 0.4.0 — 2026-11-20

### Added

- **Structural warnings:** four new validation rules in the Warnings tab. Like the existing rules, they only report; nothing is changed. They run on processes only, not on service diagrams.
  - `gateway-without-outgoing-flow`: a gateway has incoming flows but no outgoing flow.
  - `disconnected-node`: a node has no incoming and no outgoing sequence flow.
  - `no-path-to-end`: no chain of sequence flows leads to an end event; reported where the flow gets stuck (a dead end, or once per loop without a way out).
  - `activity-without-documentation`: activities with empty documentation, as one line per process.
- **Export:** the shown diagram (the chosen process, or an opened service flow or linked process) can be exported as BPMN with layout (`.bpmn` with diagram interchange), SVG or PNG.
  - An export always goes to a new file; the opened file is never written. The save dialog opens in the folder of the last export and refuses the opened file, `.twx`, `.zip` and `.xsd` files and other extensions.
  - Exports keep every flow name and lane whatever the toolbar shows, and never contain script code.
  - Images are drawn in light colours whatever the theme.
  - **Export** in the toolbar, or the new command **Lanescope: Export Diagram…**.
- **Comparing versions:** a new **Changes** tab lists what was added, removed or changed in the shown process (nodes, flows, lanes, the process itself) and in its business objects, field by field.
  - Compared with a file you pick (**Compare…** in the toolbar, or the new command **Lanescope: Compare With…**; the picked file is the older side, and the Changes tab opens once it is read), or, after a live refresh, with the version shown before it.
  - Elements pair by id, then by name, then by their neighbours.
  - New toolbar toggle **Highlight changes** marks added and changed elements in the diagram. A click (or Enter) on a row in the list selects the element, scrolls it into view and shows its details.
  - The new command **Lanescope: Clear Comparison** (or **Clear** in the tab) goes back to comparing with the previous version.
  - Script code and mapped values are never shown, the picked file is only read, and exports hold no change marks. Processes only, not service diagrams.
- **Sub-processes open as a diagram of their own**, like called services: **Open sub-process** in the details panel (with **Contains**: the number of nodes inside), a double-click on the sub-process, or selecting it and clicking its drill-down arrow opens its inside one level below, with the breadcrumb (**… › Sub1**).
  - Event sub-processes open the same way, and a nested sub-process opens as one more level. An empty sub-process says **Empty sub-process**.
  - The inside is drawn with the sub-process's own lanes: in a `.twx` export those of BAW's sub-process diagram (names, order, heights) with its positions; in Bob output a `bpmn:laneSet` inside the `bpmn:subProcess`, laid out automatically.
  - `empty-lane` also reports the empty lanes of a sub-process (`Lane "X" in sub-process "Sub1" has no activities.`). The "is drawn collapsed; its N inner node(s) are not shown" warning is gone.
  - At a sub-process level, the Changes tab lists the comparison of the process and marks the elements drawn there; sub-process lanes pair by id, else by name. In the process, a sub-process with changes inside it is marked changed and its row says **Inner changes: N**.
  - Export works at a sub-process level like at any other.

### Fixed

- The side panel keeps the selected tab when you switch between editor tabs.

## 0.3.2 — 2026-11-19

### Security

- Zip archives (`.zip` and `.twx`, and the toolkits packed in a `.twx`) are checked against the entry count and size limits before anything in them is uncompressed, and each entry's checksum is verified as it is read.
- Diagram layout runs in a separate worker thread with a time limit, so a very large or densely connected process no longer slows down the editor; flow routing has a work limit too. A diagram with more than 5,000 nodes or 20,000 sequence flows is not drawn, and the viewer says why.
- Rich-text documentation is converted to plain text in linear time.
- `.bpmn` and `.xsd` documents with a DOCTYPE are rejected, as `.twx` objects already were.
- The size of a `.bpmn` file and the `.xsd` files next to it is checked before they are read.
- Live refresh runs at most one re-read at a time, however often the file changes.
- The diagram view's Content Security Policy also sets `base-uri` and `form-action` to `'none'`.

## 0.3.1 — 2026-11-18

### Changed

- Published on [Open VSX](https://open-vsx.org/extension/selcukc/lanescope): in IBM Bob, search for **Lanescope** in the Extensions view to install it.
- The README shows screenshots and links to the Open VSX listing.

## 0.3.0 — 2026-11-18

### Changed

- The publisher is now `selcukc`, so the extension ID is `selcukc.lanescope`. Uninstall the previous build (`local.lanescope`) before installing this one; settings keep working, since their names did not change.

- Moved to a new repository ([github.com/selcukc34/lanescope](https://github.com/selcukc34/lanescope)) and renamed the extension to **Lanescope**. The command is now **Lanescope: Open** (`lanescope.open`), the custom editor `lanescope.processViewer` and the setting `lanescope.showScripts`; set `showScripts` again if you had changed it.
- Licensed under the Apache License 2.0. Third-party licenses are listed in `THIRD_PARTY_NOTICES.md`.

## 0.2.1 — 2026-11-18

### Added

- **Activity details** from `.twx` exports in the details panel:
  - the code of script tasks, with line count, folding and a **Copy** button;
  - the input and output mappings of calls, with unmapped parameters and literal values marked;
  - user task assignment, priority, due date and subject;
  - timer durations.
- **Gateway details:** selecting a gateway lists its outgoing flows with their conditions and the default flow (Bob output too).
- **Process details:** clicking the empty canvas shows the process variables (type, list, default, tracked) and the process inputs and outputs.
- **Inside &lt;service&gt;:** selecting a call of a service in a `.twx` export shows, folded, the steps of the service flow or client-side human service in flow order, one level deep:
  - scripts, calls and their mappings, REST operations and gateway conditions;
  - error boundaries, error end events, and Stay on page / Postpone events;
  - the service's inputs, outputs and variables;
  - for a human service, each coach's controls with their type and binding.

  Control types are named from the app's coach views and the `package.xml` of the packed toolkits, read only when needed.
- **Service and linked process diagrams:** a call in a `.twx` export opens as a diagram of its own.
  - **Open diagram** in the details panel, or a double-click on the call, opens the called service flow or client-side human service with BAW's positions (one pool, no lanes).
  - **Open process** opens a linked process with its lanes.
  - From there the services it calls open in turn, to any depth.
  - Service diagrams are read when first opened.
  - Calls that cannot be opened say why: **Not in this export** (toolkit services such as SQL Execute Statement) or **External service**.
- **Service diagram details:**
  - the empty canvas shows the service's kind, inputs, outputs and variables;
  - a coach shows its Control · Type · Binding table;
  - error boundaries show where they are attached and what they catch.
- **Breadcrumb:** a breadcrumb above the diagram shows the open path, e.g. Main Process › Weather Lookup › Get Weather.
  - Click a part to go back to it; **Back** and **Escape** go up one level.
  - Each level keeps its zoom and selection for the way back.
  - A call already open in the path goes back to that level with a note.
  - A path holds at most 20 levels.
  - Picking a process in the selector starts a new path.
- **`showScripts` setting:** new setting `lanescope.showScripts` (default on). When off, script text is hidden and never sent to the diagram view, including the scripts of called and opened services.
- **Show empty lanes:** new toolbar toggle **Show empty lanes**. It is on by default for a `.twx` export and off for Bob output, where an empty lane is drawn with a minimum height when the toggle is on. The default applies when a file is first opened; after that the toggle keeps its state across live refresh, the process selector and opened services.
- **`empty-lane` rule:** new validation rule. The Warnings tab lists every lane without nodes ("Lane &lt;name&gt; has no activities").

### Changed

- **Show empty lanes** replaces the **Hide empty lanes** toggle.
- The validation rules run on processes (Bob output and BPDs) only, not on service diagrams.
- Live refresh keeps the open path. If a level is no longer in the file, the viewer stays at the deepest one that is and says so in a note.
- Mapping, user task and timer settings of a form not seen in a real export are reported in the Warnings tab instead of being guessed at.
- Type names that have no row in the Data tab (System Data types such as String or Decimal) are plain text instead of links.
- Script tasks are drawn with the script task marker. Error end events and error boundaries are drawn with the error marker.

### Fixed

- Bob `bpmn:scriptTask` elements are read as script tasks instead of "unknown".
- **Flow labels:** the labels of a gateway's outgoing flows no longer crowd each other.
  - Each label sits beside the middle of its flow's first vertical segment, in the part it does not share with its siblings.
  - A label slides along that segment when a sibling's label is already there.
  - Labels keep a gap from other labels and flows.
- **Pool and lane names** no longer spill out of their header strip: a pool or lane is made tall enough for its name to fit in two lines.
- **Empty lanes of a `.twx` export**, such as the System lane of a BPD with no system tasks, were missing. They are now read from the BPMN2 model with their BAW height and order.
- **Rich text documentation:** BAW documentation written in its rich text editor showed raw HTML in the details panel, such as `<STYLE type=text/css> p{margin:0px;}</STYLE>`, `<p>`, `<br>` and `&nbsp;`. It is now read as plain text: style blocks are dropped, paragraphs, line breaks and list items start new lines, and entities are decoded. This covers processes, activities, service steps and service diagrams in `.twx` exports, and Bob output. Plain text documentation is unchanged, and HTML is never rendered.

## 0.1.0

First packaged release, for installing in IBM Bob from a `.vsix`.

- Read-only custom editor that shows a process as a BPMN diagram (bpmn-js viewer), with a details panel, a Data tab and a Warnings tab.
- Opens Bob output: a `.bpmn` file (with the `.xsd` files next to it) or a `.zip` with one `.bpmn` and its `.xsd` files. Processes without coordinates are laid out automatically in lane bands with orthogonal flows.
- Opens IBM BAW `.twx` exports: every BPD in the process app, with BAW's lanes, lane heights, positions and flow ports.
- Warns about exclusive and inclusive gateway flows that are neither the default flow nor conditioned.
- Refreshes the diagram when the opened file changes on disk, keeping zoom, scroll position and selection.
