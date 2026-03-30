# anime-learning-slicer

Local CLI that turns a full anime episode into study-friendly short clips.

## Features

- Supports common video formats handled by FFmpeg, including `mp4`, `mkv`, `mov`, `webm`, and `avi`
- Uses external subtitles (`srt`, `vtt`, `ass`) when available
- Falls back to local Whisper-based ASR when subtitles are missing
- Scores subtitle windows and exports `5-15` study clips by default
- Keeps each clip within a configurable duration range (`10-60s` by default)
- Generates study metadata for each clip: anime title, knowledge points, example sentence, key notes, and bilingual subtitles

## Quick start

```bash
npm install
npm run build
npm start -- slice --input ./episode01.mkv --anime "Bocchi the Rock!" --episode "EP01" --subtitle ./episode01.ass --output ./output/bocchi-ep01
```

If `--subtitle` is omitted, the tool will try to generate subtitles from the audio track with a local Whisper model.

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
- `manifest.json`: summary manifest for all generated clips

The generated `manifest.json` and `clips/*.mp4` can be imported directly into the YuruNihongo web app's short-video module from the "我的" page.

## Notes

- This tool is designed for local processing of videos you already have access to.
- The first ASR run may download model weights and can take a while.
