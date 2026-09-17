# ScapeMaker

An educational soundscape workstation for filmmaking students. A multi-track
timeline fed by the student's own recordings, the Internet Archive, the radio
aporee map (via the Archive mirror), and Freesound — with licensing built into
the tool rather than bolted onto the brief.

**Static site. No backend, no accounts, no API key of its own, no running cost.**
Freesound is optional and keyed by the student; everything else works without it.

## Develop

```bash
npm install
npm run dev        # Vite prints the local URL
npm run typecheck  # tsc --noEmit, strict
npm test           # vitest — audio maths, licence logic, geo maths, WAV, schema
npm run build      # tsc + vite build → dist/
```

Push to `main` runs typecheck + tests + build and publishes `dist/` to GitHub
Pages (`.github/workflows/deploy.yml`). The Vite `base` is `/<repo>/` for project
Pages; override with `BASE_PATH`.

## Architecture

No UI framework. A small number of long-lived panels driven by a central store.

| Layer | Files | Notes |
|---|---|---|
| Data model | `src/state/project.ts` | Versioned schema with a migration hook. The `.scapemaker` file is this object as JSON — **no audio**. |
| Store / history | `src/state/store.ts`, `history.ts`, `edits.ts`, `effectEdits.ts` | Subscribe/emit store; every timeline edit is an undoable command. |
| Asset store | `src/audio/assetStore.ts` | **One decoded `AudioBuffer` per source asset.** Clips are non-owning views. Liveness is derived from the project (`retain`), not ref-counted — undo/redo move clips in and out without any acquire/release pair. Idle assets are kept until the memory is wanted, then swept oldest-first past 80% of budget; a live asset is never evicted, so a full budget is reported, not papered over. Originals cached in IndexedDB; decoded buffers never are. |
| Peaks | `src/audio/peaks.ts` | Multi-resolution `Int8Array` pyramid. Waveforms are **never** painted from raw samples. |
| Graph | `src/audio/graph.ts` | One builder for live playback **and** the offline render, so the two cannot diverge. |
| Automation | `src/audio/automation.ts` | Linear / smooth / bezier. Bezier is sampled to a `Float32Array`; the **same** sampler runs live and offline. `tests/render-null.test.ts` guards it. |
| Effects | `src/audio/effects/eq.ts`, `reverb.ts` | 5-band biquad EQ; reverb from **runtime-synthesised** impulse responses (no shipped IR files). |
| Render / export | `src/audio/render.ts`, `wav.ts`, `src/export/*` | `OfflineAudioContext` mixdown + stems, hand-written WAV encoder, sources CSV, reflection markdown. Everything leaves as ONE `.zip` (`export/zip.ts`, store-only, no dependency) — eleven separate downloads hit Chrome's multi-download prompt. A stem is the track alone: it ignores mute/solo and the master trim. |
| Storage | `src/audio/storage.ts` | Asks for persistent storage at boot. A project file holds no audio and a local recording has no URL to re-fetch from, so the IndexedDB cache is the only copy; if the browser will not promise to keep it, the student is told once. |
| Sources | `src/sources/*` | `SoundResult` is the shared shape all four sources normalise to. `local.ts` is the primary path. `aporee.ts` searches the Archive mirror with an absolute-value bounding box + a signed haversine (see the note on `absRanges` in `geo.ts`). |
| Licence | `src/licence/model.ts`, `warnings.ts` | Parse → classify → badge / warn / allow. NonCommercial and NoDerivatives warn at import; the decision is recorded; export repeats the notice and lists the specific assets. |
| UI | `src/ui/*` | Canvas timeline lanes, one delegated tooltip controller, dark default with an explicit light choice. Every colour is a token in `src/styles/tokens.css` — defined nowhere else. `h()` derives `aria-label` from a control's tooltip title, so icon-only buttons are named. |
| Project files | `src/state/persist.ts`, `fileHandle.ts` | Save writes back to the file that was opened (File System Access API), falling back to a download. Shift-click or Cmd/Ctrl+Shift+S saves a copy. |

## Design rules baked in

1. One `AudioBuffer` per asset; clips are views onto it.
2. Never paint a waveform from raw sample data — only the peak pyramid.
3. No backend. Every source is reached directly from the browser.
4. Freesound is optional and student-keyed; its responses are never persisted.
5. Colour comes only from `tokens.css`; both themes work everywhere.
6. All editing is non-destructive.
7. Playback and export apply every sound-affecting parameter with the same code.
8. A gesture is one undo step, and redo lands where the gesture ended.
9. Basic mode really is smaller: select/trim/split, no automation, no EQ or reverb.

## Known gaps

- Integrated loudness is a best-effort ITU-R BS.1770 implementation.
- The looped portion of a clip isn't re-tiled in the waveform canvas (it draws
  one iteration stretched across the full repeated span); dashed tick marks at
  each repeat boundary make the loop count legible in the meantime.
- The Freesound preview CORS path still wants a one-off manual check.
- The 600 MB asset budget is still a guess. It is now enforced and visible, so
  hitting it is a clear refusal rather than a dead tab — but the number itself
  has not been measured against a real classroom machine.
- Only one clip can be selected at a time; there is no rubber-band select and no
  track reordering.
- Save-in-place needs the File System Access API (Chromium). Other browsers get
  the download fallback, which still accumulates copies.
