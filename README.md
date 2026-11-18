# Lanescope

[![CI](https://github.com/selcukc34/lanescope/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/selcukc34/lanescope/actions/workflows/ci.yml)

> Not affiliated with or endorsed by IBM. See [Trademarks](#trademarks).

A read-only extension for IBM Bob (a VS Code based IDE) that renders IBM Business Automation Workflow (BAW) processes as BPMN diagrams. It opens the process files Bob produces and IBM BAW `.twx` exports, and never writes, changes, or deploys them.

## Installation

Lanescope is an extension for IBM Bob and is in preview. It is tested with IBM Bob 2.2.2 (VS Code 1.126) and needs VS Code 1.85 or later.

<!-- TODO: link the Open VSX listing once the extension is published. -->

### From Open VSX

In IBM Bob, open the **Extensions** view (Cmd+Shift+X on macOS, Ctrl+Shift+X on Windows and Linux), search for **Lanescope** and click **Install**. IBM Bob installs it from [Open VSX](https://open-vsx.org).

### From a GitHub Release (.vsix)

For corporate networks without access to Open VSX, or to install a specific version:

1. Download `lanescope-<version>.vsix` from the [Releases](https://github.com/selcukc34/lanescope/releases) page.
2. In IBM Bob, open the **Extensions** view, click **…** (Views and More Actions) at the top of the view and choose **Install from VSIX...**.
3. Pick the downloaded file and reload the window if asked.

To update, install the newer `.vsix` the same way. To remove the extension, find **Lanescope** in the Extensions view and choose **Uninstall**.

## Open a process

- Right-click a `.bpmn`, `.zip` or `.twx` file in the Explorer and choose **Lanescope: Open**, or
- run **Lanescope: Open** from the Command Palette, or
- use **Open With... → Lanescope** on the file.

The viewer is never the default editor for these file types, so `.zip` and `.bpmn` files still open as before unless you pick the viewer.

### Toolbar

| Control | Effect |
| --- | --- |
| **Hide generated flow labels** | Hides flow names that only repeat the target ("To &lt;target&gt;"). Condition and default flows keep their label. On by default. |
| **Show empty lanes** | Draws lanes that hold no nodes. On by default for a `.twx` export (BAW draws them, with their BAW height); off for Bob output, where the Warnings tab lists them instead. |
| **−**, **+**, **Fit** | Zoom out, zoom in, fit the diagram to the window. |

Changing a toggle redraws the diagram and keeps the zoom and the selection. The toggles keep their state across live refresh, the process selector and opened services; the default by input type applies only when the file is first opened.

## Supported inputs

| Input | What is read |
| --- | --- |
| `.bpmn` (Bob output) | The BPMN process. The `.xsd` files in the same folder supply the business object types. |
| `.zip` (Bob output) | One `.bpmn` and its `.xsd` files inside the archive. |
| `.twx` (IBM BAW export) | Every BPD (business process definition) in the process app, with BAW's own lanes and positions. |

Bob output has no diagram coordinates, so the viewer lays it out automatically: lanes become horizontal bands and flows are routed orthogonally.

### TWX exports

A `.twx` export can hold several BPDs. Each one is a process in the viewer; when there is more than one, pick it in the toolbar's selector.

- Nodes, flows, names, conditions and documentation come from the BPMN2 model BAW stores in each BPD. Lanes, lane heights and positions come from BAW's own diagram model, so the diagram keeps the layout of the BAW editor. Empty lanes, which that model leaves out, come from the BPMN2 model with their BAW height. Flows leave and enter nodes through the sides BAW saved for them and are routed around the other nodes. A BPD without positions is laid out automatically.
- The details panel names the service or process a call activity calls. The Data tab lists the process app's business objects.

### Opening called services and linked processes

A call in a `.twx` export can be opened as a diagram of its own: a service flow, a client-side human service or a linked process. From there you can open the services it calls in turn, as deep as the calls go.

- Select the call and click **Open diagram** (**Open process** for a linked process) in the details panel, or double-click the call in the diagram.
- Service flows and human services are drawn with the positions of the BAW editor, in one pool without lanes. A linked process is drawn with its lanes, like a process picked in the selector. A service without positions is laid out automatically.
- The breadcrumb above the diagram shows the path, e.g. **Main Process › Weather Lookup › Get Weather**. Click a part to go back to that level; **Back** or **Escape** goes up one level. Each level gets its zoom and selection back when you return to it.
- A call that is already open higher up in the path goes back to that level instead of opening it again, with the note "… is already open in this path". A path holds at most 20 levels.
- Calls that cannot be opened say why instead of showing a button: **Not in this export** (for example System Data's SQL Execute Statement and other toolkit services) or **External service** (REST steps and external services).
- Picking another process in the selector starts a new path.
- A service is read when it is first opened, not when the file is opened.

In a service diagram, clicking the empty canvas shows the service's kind (**Service flow** or **Client-side human service**) with its **Inputs**, **Outputs** and **Variables**. Selecting a coach shows its **Control · Type · Binding** table. Scripts, calls with their mappings, REST steps, gateway conditions and error boundaries show the same details as elsewhere. The validation rules (Warnings tab) run on processes only, not on service diagrams.

### Details panel

Click a node to see what the source holds for it. A section appears only when the source has that information.

| Selection | Shown |
| --- | --- |
| Script task | The script as stored, with its line count, a **Copy** button and, for scripts longer than 20 lines, **Show all N lines**. |
| Call (system task, user task, linked process) | **Input mapping** (Parameter, Type, Value) and **Output mapping** (Parameter, Target) for every parameter of the called service or process. A parameter the caller leaves unmapped shows **not mapped**; a literal value is shown without its quotes and marked **literal**. |
| Call of a service (TWX) | **Inside &lt;service&gt;**, folded: the steps of the called service flow or client-side human service in flow order (script, call, REST, gateway, coach, event), one level deep. Scripts fold with the same code block; calls show what they call and their mappings; REST steps the external service and operation; gateways every outgoing flow with its condition (**no condition** when it has none) and the default; error boundaries what they catch (**catches: all** or the error code) and where they lead. Then the service's **Inputs**, **Outputs**, **Variables** and, for a human service, a **Control · Type · Binding** table per coach. A service with nothing between start and end says so. |
| Linked process | **Open process** opens the called process below the current one (see the breadcrumb) when the export holds it. |
| Coach (in a human service diagram) | **Controls**: Control · Type · Binding of every control of the coach. |
| Error boundary (in a service diagram) | The step it is attached to and what it catches (**all** or the error code). |
| User task | **Assignment**: assignment type, lane, performer, priority, due date and subject. |
| Timer event | Duration and unit; for a boundary timer also whether it interrupts and repeats. |
| Gateway | **Outgoing conditions**: target, condition and default flow of every outgoing flow (also for Bob output). |
| Empty canvas | The process: its **Inputs**, **Outputs** and **Variables** (type, list, default value, tracked). |

The viewer only shows what is in the file. It does not judge, score or rewrite any of it.

## Live refresh

The viewer watches the opened file and re-reads it 300 ms after the last change. For a `.zip` or `.twx` it watches that file itself. For a `.bpmn` it also watches the `.xsd` files in the same folder. A file that is deleted and written again (as Bob may do) is picked up too.

- Zoom, scroll position and the selected element (if its id still exists) are kept. The toolbar shows **Updated hh:mm:ss**: the last time the file was read.
- An opened service or linked process stays open. If a level of the breadcrumb is no longer in the file, the viewer stays at the deepest level that still is and says so in a short note.
- If the new file cannot be read, the last good diagram stays on screen and the error is shown in a banner above it. You can dismiss the banner with **×**. It goes away by itself once the file is fixed.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `lanescope.showScripts` | `true` | When `false`, the details panel shows "Script content hidden by the lanescope.showScripts setting." instead of the code, and script text is not sent to the diagram view at all, in opened services too. Open viewers update when the setting changes. |

## Privacy

- **No network requests, no telemetry.** Everything stays on your machine: the extension reads the opened file locally and sends nothing anywhere.
- Scripts, mappings and conditions are shown as plain text. They are never run, evaluated or sent anywhere.
- To keep script code off the screen (for example while sharing it), turn off `lanescope.showScripts`.

## Read-only guarantee

- The extension only reads the files you open. It never writes, changes, renames or deletes a `.bpmn`, `.xsd`, `.zip` or `.twx` file, and it never deploys anything.
- Archives are read in memory; nothing is extracted to disk.
- The diagram view runs under a strict Content Security Policy, uses only scripts bundled in the extension, and makes no network requests.

## Warnings

The **Warnings** tab lists issues found in the opened process. The viewer only reports them; it does not fix anything.

| Rule | When it fires |
| --- | --- |
| `gateway-unconditioned-flow` | An exclusive or inclusive gateway with two or more outgoing flows has a flow that is neither the default flow nor conditioned. Gateways with a single outgoing flow (joins) are not checked. |
| `empty-lane` | A lane holds no nodes: "Lane &lt;name&gt; has no activities". |

A Bob process imported into BAW 8.6.6 and exported again shows `gateway-unconditioned-flow` warnings, because BAW drops the gateway conditions on import.

## Known limits

- Of the toolkits packed in a `.twx` export (`toolkits/*.zip`) only `package.xml` is read, and only to name the coach views that controls use; their services are not read. The process details list the toolkits the app depends on.
- **Inside &lt;service&gt;** in the details panel lists one level deep; to go further, open the service as a diagram.
- Services of toolkits cannot be opened. Coaches are listed as a control table, not drawn.
- Children of collapsed sub-processes are not drawn.
- Bob output is always laid out automatically; any layout made in another tool is not kept.
- Size limits protect against oversized archives: a Bob `.zip` may hold at most 500 entries and 50 MB uncompressed; a `.twx` may be at most 512 MB, with at most 64 MB per entry.
- The viewer cannot edit, export or save diagrams.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch and pull request flow. Security issues: [SECURITY.md](SECURITY.md).

### Build

Requires Node.js 20 or later.

```sh
npm install
npm run build   # type-check, then bundle into dist/
npm test        # run unit tests (vitest)
npm run lint    # eslint
npm run watch   # rebuild on change
npm run package # production build, then lanescope-<version>.vsix
```

### Test fixtures

The repository holds no IBM BAW exports: `.twx` files can contain customer processes and IBM toolkit content, so `.gitignore` keeps them out.

- The TWX readers are tested in every run against a small synthetic export that the tests build in memory (`test/syntheticTwx.ts`).
- Tests against real BAW 8.6.6 exports read them from `test/fixtures/local/`, under the file names listed in `test/localFixtures.ts`. When a file is missing, the tests that need it are skipped, so CI runs without them.

### Run from source

1. Open this folder in VS Code or IBM Bob.
2. Press **F5** (launch configuration "Run Extension"). This builds the extension and opens an Extension Development Host window.
3. In that window, open the Command Palette and run **Lanescope: Open**.

### How to test live refresh

1. Extract the fixture into the git-ignored output folder:

   ```sh
   mkdir -p test/output/live
   unzip -o test/fixtures/bob/order-delivery-process.zip -d test/output/live
   ```

2. Press **F5**. In the Extension Development Host, open this repository folder, then right-click `test/output/live/order-delivery-process.bpmn` and choose **Lanescope: Open**.
3. Zoom in, scroll, and click a task so the side panel shows it.
4. In a text editor, change the process name (the `name` attribute of `<bpmn:process>`) or a task name, then save. Within a second the diagram redraws, the zoom, scroll position and selection stay, and **Updated hh:mm:ss** changes.
5. Break the XML (for example, delete a closing `>`) and save. The last good diagram stays and an error banner appears. Undo the change and save: the banner goes away.
6. Delete the file and re-extract it with the command from step 1. The banner appears while the file is missing, and the diagram comes back after the file is written again.
7. Close the viewer tab. No further reloads happen (the file watcher is disposed).

All changes go to the copy in `test/output/live/`. The fixture in `test/fixtures/` is never modified.

## License

Apache License 2.0, see [LICENSE](LICENSE). The extension bundles third-party libraries under their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Trademarks

IBM, IBM Business Automation Workflow and IBM Bob are trademarks of International Business Machines Corporation. Lanescope is an independent project, not affiliated with or endorsed by IBM.
