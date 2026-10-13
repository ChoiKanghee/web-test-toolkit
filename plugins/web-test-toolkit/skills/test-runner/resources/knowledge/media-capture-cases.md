# Cases that need a camera, a microphone or a screen share

Load this when a `Tool=MCP` (or `Tool=PW`) case hangs on a permission-shaped step, or
when planning a case that captures media.

## The symptom

The button flips to a loading label — `Starting...`, `Connecting...` — and **stays there
forever. No console error, no failed request, no dialog you can see or snapshot.**

That signature means the page called `getUserMedia` or `getDisplayMedia` and the browser
opened a **native, out-of-page picker** (the "Choose what to share" window). It is drawn by
the OS/browser chrome, not by the DOM, so nothing in the accessibility snapshot shows it and
no automation click can reach it. The promise never settles; the app is waiting correctly.

**This is not an application bug.** Do not file it as one, and do not record the case as
`failed` — record it `skipped` with a `note`, or fix it with the flags below.

## The fix: Chrome flags, passed through chrome-devtools MCP

`chrome-devtools-mcp` forwards arbitrary Chrome switches with `--chrome-arg` (repeatable).
It is already wired up in [`.mcp.json`](../../../../.mcp.json):

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y", "chrome-devtools-mcp@latest",
        "--chrome-arg=--use-fake-ui-for-media-stream",
        "--chrome-arg=--auto-select-desktop-capture-source=Entire screen"
      ]
    }
  }
}
```

- `--use-fake-ui-for-media-stream` — auto-accepts every media permission prompt (camera,
  mic, **and** the screen-share picker) and feeds a synthetic device.
- `--auto-select-desktop-capture-source=<substring>` — answers the screen-share picker by
  picking the first source whose name contains the substring. `Entire screen` is the safe
  default.

**`--chrome-arg` only applies when the MCP server launches Chrome itself.** With
`--browserUrl`, `--wsEndpoint` or `--autoConnect` it is attaching to a browser someone else
started, and the flags are ignored — start that Chrome with the switches instead.

**MCP servers load once, at session start.** After editing the plugin's `.mcp.json` you must start a new
Claude Code session before the flags take effect.

## What was actually measured (2026-09-22)

Probe: [`resources/probes/gdm-flag-probe.mjs`](../probes/gdm-flag-probe.mjs) — a local
page over `http://127.0.0.1` (a secure context; `getDisplayMedia` is `undefined` on
`about:blank`) calls `getDisplayMedia` from a real click, once per flag combination.

| Flag | headed Chromium | headless |
|---|---|---|
| *(none — control)* | **hangs**, never settles | `NotSupportedError` |
| `--use-fake-ui-for-media-stream` | **works** → `video:screen:0:0` | **works** |
| `--auto-select-desktop-capture-source="Entire screen"` | **works** → `video:screen:0:0` | `NotSupportedError` |
| `--auto-select-tab-capture-source-by-title="<title>"` | hangs | `NotSupportedError` |
| `--auto-accept-this-tab-capture` | hangs | `NotSupportedError` |

Two conclusions worth keeping: the control run **reproduces the exact hang** the flags are
meant to cure, and `--use-fake-ui-for-media-stream` is the only switch that works in both
modes — so prefer it, and keep `--auto-select-desktop-capture-source` alongside it as the
belt-and-braces answer for the headed browser the MCP server launches by default. The two
tab-specific switches did nothing here; do not reach for them first.

End to end: a throwaway probe (target-specific, not kept in this repo) drove
a real TC-023 "start a meeting" flow (seed session → **Start Meeting** → name → **Start**) in a
headed Chromium carrying both flags. It left `/home` for
`/meetings/<id>/live` **within one second** and rendered the full live-meeting UI
(`Connecting...`, timer, `Mute` / `Pause` / `End Meeting`). The same click without the flags
is the indefinite `Starting...` hang. So the flags fix this class of case in practice, not
just in the probe.

## Caveats before you turn this on for a whole run

- **The stream is fake.** You get a synthetic screen/mic source, so you can verify *that the
  meeting starts, connects and renders* — you cannot verify transcription of real audio or
  the contents of a real shared tab. State that limit in the test-plan row.
- **Negative permission cases die.** `--use-fake-ui-for-media-stream` auto-*accepts*
  everything, so "user denies screen share" can no longer be tested in the same session.
  Keep such a case on a session without the flag, and say so in its steps.
- **Playwright specs need the same flags**, separately — they are not covered by the plugin's `.mcp.json`.
  Add them to `launchOptions.args` in the runner config, or keep the case on `Tool=MCP`.
- **Starting a meeting writes real data on staging.** Clean it up (see the cleanup rule in
  `SKILL.md`): the probe above created two meetings and deleted them again, returning the
  Active list to `0 meetings`.
