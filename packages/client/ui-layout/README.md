---
description: "Simin workbench navigation, document reading, existing conversation slots, detail panels, and theme presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

## Summary

This package provides Simin's personal workbench over real project files and the existing conversation. AppFrame owns viewport measurement, shell overlays, and the floating Agent detail panel; SiminShell owns navigation and reading. The theme presenter projects palette, content font size, and document metadata.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Home lays out actual project folders in four columns on wide windows and fewer columns on smaller windows, with zero to three paper previews according to the real document count. Transparent backs span the folder width. Papers stay inside the folder; the front paper keeps the project name visible above a bounded document preview. Empty folders show the project name on the pocket without a paper. The greeting uses heavier text and a decorative wave emoji. Project navigation restores the main conversation through the workspace owner. Documents, full-text search, templates, trash, and settings use local Host data. Templates add a draft without sending or creating files.

Reading and conversation share the project view on wide windows; narrower windows switch between them. Save proposals display content or line differences before confirmation. File mutations carry the observed content version; conflicts retain the current document. Navigation and display preferences use localStorage; document bodies remain on disk.

The project sidebar has one primary New document action for the current project. Only project headers show a breadcrumb; global pages omit it. Project headers retain search and focus controls; New project actions remain on global pages. Conversation mode has no extra workbench title bar; the sidebar's document entries return to reading.

Workbench navigation and template entries use a selected set of [Heroicons v2.2.0 solid icons](https://github.com/tailwindlabs/heroicons/tree/v2.2.0/optimized/24/solid); their MIT license is retained in [SiminIcons](src/client/SiminIcons.tsx). Templates appear as flat rows with thin dividers, monochrome icons, and the shared rounded action style. Each preview dialog names its selected starting point.

Workbench settings use flat groups with hairline dividers and monochrome shared switches. Local preferences save immediately; directory copying and the existing model settings dialog remain available through compact row actions.

Dublin Lab adds GitHub Trending to the navigation rail, defaulting to weekly rankings with daily/monthly and language filters. Local cloning, Fork, independent copying and GitHub Pages publishing require explicit dialog confirmation; remote writes use the account shown on the page. The page reads the loopback-only GitHub owner in [web-app](../../bundle/web-app/README.md).

The header To-dos and Quick notes entries open mutually exclusive, non-modal drawers without unmounting the workspace. Tasks support editing, completion filters and confirmed deletion. Plain-text notes save on every edit and retain a list of saved notes, without revision history. Records are shared across projects in the same browser profile, stored separately under `dublin.organizer.v1.*` in localStorage, and survive application restart. Clearing browser data removes them; they are not project files or cloud backups. Failed writes remain in memory with a retry control and an unsaved warning; quitting before a successful retry loses those pending edits. Storage events merge other-window edits per item; concurrent edits of the same saved item use the last successful write.

Each repository card labels its author-supplied description as the project purpose. The optional Chinese translation switch is off initially; enabling it sends only public descriptions through the Host to [MyMemory](https://mymemory.translated.net/doc/spec.php), with three UI requests at a time. Machine translations preserve the original in a disclosure, and unavailable/quota-limited translations retain the original with a warning. Missing descriptions link users to the repository README rather than inventing a purpose. The idle camera island is a plain black pill with no visible text or decoration; its accessible label remains available to assistive technology. The appearance entry contains text only.

The centered camera island requests video only after a click, mirrors a local live preview, and stops all tracks on preview click, page hiding, unmount, or a late permission result after cancellation. It does not record or upload. The appearance control in Settings offers light and charcoal styles through the existing theme service. Appearance metadata stays in `dublin.appearance.v1`; background images stay in local IndexedDB and accept PNG/JPEG/WebP/GIF up to 20 MB. The workspace and conversation share the image with independent 0–100% transparency controls; 0% shows it fully and 100% hides it. Older preferences initialize conversation transparency from the workspace value. The document panel and input card retain readable fills. Replacing or unmounting a background revokes its object URL. Browser storage clearing removes these preferences, not project files.

The conversation clips the full workbench image canvas instead of fitting the image to its own pane. Both layers retain the same scale and position when navigating or resizing the window and sidebar; only their transparency differs.

The root keeps the `main`, `rightbar`, `shell.bottom`, and `shell.overlay` slots. The hidden legacy sidebar keeps its settings portal mounted. Global-panel selection and the existing conversation continue to use `ctx.layout`; the workbench supplies the visible navigation.

<a id="window-chrome-seat"></a>
### Window-chrome seat

Simin's macOS rail places its brand below the traffic lights with 48px top padding. The header marks draggable space with `data-window-drag`; controls remain clickable. The root overlay clearance variables retain the platform titlebar and native-fullscreen behavior. `shell.leading` remains registered for compatibility but is not rendered by this frame.

### Theme presentation

The presenter consumes resolved theme snapshots and projects them onto the document: `html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens and `--dsh-content-font-size` as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background. Disposing the presenter removes its metadata node with its other global writes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`selectPanel(id)` validates the live `main` registry. `beginNavigation()` aborts superseded navigation without cancelling underlying Session creation. The root store separates panel selection from viewport and detail-panel measurements. AppFrame measures its own box with ResizeObserver and a cancellable animation frame, and releases both on unmount.

Project opening, draft insertion, conversation search, and model settings use DOM events handled by their existing owners. ui-layout does not value-import ui-workspace. The workbench polls local project data every two seconds with abortable requests; it retains content when reads fail. Existing Agent detail panels render in the floating rightbar slot, which is unavailable below 640px. The independent title component projects the active Session title. Theme updates remain event-driven pure DOM writes.

Project reading and conversation share the theme's base surface and use thin separators between navigation, panes, and headers. The split conversation uses its existing Session header; a separate workbench chat toolbar appears only in the chat-only view.

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the layout surface is not enough. They move from the frame to the columns it renders and the theme it presents.

- [ui-sidebar](../ui-sidebar/README.md) — occupies the `sidebar` column and its seats.
- [ui-conversation](../ui-conversation/README.md) — occupies the `main` key `conversation`.
- [ui-sidebar-right](../ui-sidebar-right/README.md) — occupies the `rightbar` column with one docking surface per session.
- [ui-theme](../ui-theme/README.md) — the theme seam whose resolved snapshots the presenter consumes.
- [Web client architecture](../../../docs/subsystems/web-client.md) — how browser plugin rows load and register slots.

-----

The home page omits task and reminder preview cards. Recording, Quick notes, To-dos and Reminders appear beside search in the top header; API keys sit at the bottom of the navigation rail. Settings contains Appearance. These drawers are mutually exclusive. It reads the Host catalog, edits full timing/content, pauses/resumes tasks and confirms cancellation. Unread in-app banners remain visible with the drawer closed. The feed polls while mounted, refreshes on visibility changes and aborts requests and clears its timer on unmount. Creation uses conversation in Standard mode; reminder persistence belongs to [web-app](../../bundle/web-app/README.md#local-workbench-behavior), not localStorage.

<a id="model-experience"></a>

Temporary chats open from the home quick action or navigation rail without a project picker. The sidebar lists retained Host history and restores the exact Session identity after restart or project navigation. Chat reuses the existing slot and aligned background. Continue in project preserves the original and opens a completed-history continuation; blank/running chats cannot transfer. Failures keep the list available for retry.

The transparent compact header shows the current chat title and opens project selection in an anchored searchable picker. Escape and outside clicks dismiss it; continuation requires an explicit project selection and confirmation. Only blank chats show the short history-retention hint.

The top header groups search, Recording, Quick notes, To-dos and Reminders with a shared pill outline. Recording uses a small red dot; notes, to-dos and reminders use compact emoji marks, repeated in their drawer titles. Marks are decorative and do not change accessible names. During capture, the Recording entry shows its elapsed status. Tool controllers remain mounted across navigation so reminders continue arriving and recording continues with its drawer closed. Drawer clearance follows the responsive platform header height. The search dialog input uses border-box sizing so its full width preserves both content gutters.

The Recording header entry and API keys bottom navigation entry open mutually exclusive right drawers. Organizer changes synchronize within the same window as well as between windows. Recording stays active when its drawer closes; its elapsed state remains in the header. The desktop bridge saves mono 16 kHz PCM to seekable WAV files incrementally, restores interrupted recordings, and caps each recording at two hours. Playback, seeking, rename, export and confirmed deletion work without a project. Upload-and-transcribe requires explicit confirmation; Alibaba Cloud returns timestamped anonymous speaker segments. Organizing explicitly sends the transcript to the configured text model; saving notes and adding each reviewed action remain separate gestures. API credentials are configured separately from vault cards.

Vault cards contain provider, account and a masked key, with an expanding editor. Secrets remain in the native encrypted file; reveal, copy, existing-card edits and deletion require native user presence. Revealed values hide on blur or after sixty seconds; native clipboard contents are cleared after thirty seconds only if still equal to the copied key. Recording and vault operations require the desktop application; the web page shows that limitation.

## Model Experience

None, as this UI layer registers no agent prompt or tool and its explicit transcription and summary requests run separately from agent conversations.

#### KV Cache effect

No effect on agent-session KV caches. Explicit recording summaries are separate requests containing the selected transcript.

## Known Limitations and Deferred Work

- Project navigation is personal and local; the filesystem root belongs to the Host configuration in this checkout.
- File refresh uses polling; external edits may take up to one polling interval to appear.
- The workbench does not connect Figma, GitHub, or Feishu, and does not prescribe project stages.
- Windows layout and public distribution are outside this personal Mac build's qualification.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
