# Electron analysis verification — 2026-10-29

Artifact: `electron-app.asar` (2,365 bytes), self-authored for this test.
SHA-256: `5aa7a467428a84b5ee8a32cdbac06cbb3066d550371ccfa339d0d4da71e810b1`

## Fixture

A minimal but realistic Electron application:

- `main.js` — one `BrowserWindow`, `ipcMain.handle("config:read")`, `ipcMain.on("telemetry:send")`
- `preload.js` — `contextBridge.exposeInMainWorld("xtnaDemo", { readConfig, sendTelemetry })`
- `renderer.js` — calls both exposed members
- packed with `@electron/asar` into `electron-app.asar`

No third-party code, no network, no native modules.

## Result

`analyze-javascript-application electron-app.asar --detail summary --evidence_output …`

| Field                          | Value                                   |
| ------------------------------ | --------------------------------------- |
| format                         | asar                                    |
| relevant files                 | 5                                       |
| parsed JavaScript files        | 3                                       |
| parse failures                 | 0                                       |
| visited AST nodes              | 178                                     |
| findings                       | 17                                      |
| browser windows                | 1                                       |
| preload entrypoints            | 1                                       |
| contextBridge APIs             | 1                                       |
| exposed API members            | **2** (`readConfig`, `sendTelemetry`)   |
| IPC operations                 | 4                                       |
| literal channels               | **2** (`config:read`, `telemetry:send`) |
| renderer transmissions         | 2                                       |
| main handlers                  | 2                                       |
| paired renderer transmissions  | **2**                                   |
| unpaired literal transmissions | 0                                       |

The counts match the fixture exactly: two channels, each with one renderer side and one main
side, paired.

## Notes

- Temp, HOME, APPDATA and LOCALAPPDATA were redirected to `E:\deepseek project\XTNA\.tmp-provider`.
  No C: writes.
- Analysis completed in one pass; the evidence bundle was written next to the fixture.
- This is a synthetic application, not a shipped product. It proves the pipeline, not the
  behaviour of any real vendor's app.

## Verdict

End-to-end Electron reconstruction is verified: asar inventory, main/preload/renderer parsing,
contextBridge surface, and IPC channel pairing.
