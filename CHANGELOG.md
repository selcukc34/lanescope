# Changelog

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
