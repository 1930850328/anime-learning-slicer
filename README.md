# anime-learning-slicer

Local CLI that turns a full anime episode into study-friendly short clips.

## Features

- Supports common video formats handled by FFmpeg, including `mp4`, `mkv`, `mov`, `webm`, and `avi`
- Uses external subtitles (`srt`, `vtt`, `ass`) when available
- Falls back to local Whisper-based ASR when subtitles are missing
- Scores subtitle windows and exports `5-15` study clips by default
- Keeps each clip within a configurable duration range (`10-60s` by default)
- Generates study metadata for each clip: anime title, knowledge points, example sentence, key notes, bilingual subtitles, and cover images
- Auto-publishes generated clips into the YuruNihongo app's `public/generated-slices` directory
- Includes a `sync-app` command with optional watch mode powered by `chokidar`

## Quick start

```bash
npm install
npm run build
npm start -- slice --input ./episode01.mkv --anime "Bocchi the Rock!" --episode "EP01" --subtitle ./episode01.ass --output ./output/bocchi-ep01
```

If `--subtitle` is omitted, the tool will try to generate subtitles from the audio track with a local Whisper model.

If a sibling `Happy-Japannese` repo is detected, the slicer will auto-publish into that app after each run.
You can also point to the app explicitly:

```bash
npm start -- slice --input ./episode01.mkv --anime "Bocchi the Rock!" --episode "EP01" --subtitle ./episode01.ass --app ../Happy-Japannese
```

To re-sync an existing slicer output into the app:

```bash
npm start -- sync-app --manifest ./output/bocchi-ep01/manifest.json --app ../Happy-Japannese
```

## FFmpeg

The CLI expects `ffmpeg` and `ffprobe` to be available on your `PATH`.
You can also point to custom binaries with:

```bash
set FFMPEG_BIN=C:\path\to\ffmpeg.exe
set FFPROBE_BIN=C:\path\to\ffprobe.exe
```

## Output

The output directory contains:

- `clips/*.mp4`: rendered study clips
- `clips/*.vtt`: clip-aligned bilingual subtitles
- `clips/*.json`: per-clip metadata
- `covers/*.jpg`: cover images extracted from rendered clips
- `manifest.json`: summary manifest for all generated clips

When auto-publish is enabled, the slicer also writes:

- `../Happy-Japannese/public/generated-slices/index.json`
- `../Happy-Japannese/public/generated-slices/<slug>/manifest.json`
- `../Happy-Japannese/public/generated-slices/<slug>/clips/*`
- `../Happy-Japannese/public/generated-slices/<slug>/covers/*`

The YuruNihongo app scans this folder automatically, so clips appear in the short-video feed without manual upload.

## Notes

- This tool is designed for local processing of videos you already have access to.
- The first ASR run may download model weights and can take a while.
- Video slicing is handled directly by FFmpeg instead of a thin wrapper, so the CLI can retry and validate suspicious renders.
- The `sync-app --watch` workflow uses `chokidar` to keep the web app in sync during local iteration.
