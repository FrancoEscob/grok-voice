---
name: grok-voice
description: >
  Grok/xAI speech with the user's own Grok subscription (one browser login, no API key)
  or XAI_API_KEY. Use for text-to-speech, voiceover, narration, voces, locución;
  speech-to-text, transcripción, dictation; or wiring Grok voice into an app.
---

# Grok Voice

Speech and transcription on the Grok account of whoever is at this machine. One browser approval covers both; the token stays on their disk.

The CLI is `scripts/grok-voice.mjs` next to this file (Node 20+; ffmpeg only for mp3/m4a/ogg output and durations). Locate it once per session:

```bash
for d in "${GROK_VOICE_HOME:-}" ~/.grok/skills/grok-voice ~/.claude/skills/grok-voice ~/.codex/skills/grok-voice ~/.agents/skills/grok-voice; do
  [ -f "$d/scripts/grok-voice.mjs" ] && GROK_VOICE="$d/scripts/grok-voice.mjs" && break
done
node "$GROK_VOICE" status
```

Pick the branch:

- **Audio file or narration** → [Speak](#speak).
- **Transcript of a recording** → [Transcribe](#transcribe).
- **An app** (reader, dictation tool, bot) → the app calls the API itself with the person's bearer; read [references/app-api.md](references/app-api.md) and build from it.

## Session

`status` says whether a session exists. If it says "No session", run `node "$GROK_VOICE" login` (add `--no-open` on a headless box). The moment the URL and code print, relay both to the person verbatim, then wait for login to exit — the person approves in their browser; that approval is the only way in.

The session lives in `~/.config/grok-voice/auth.json` (mode 600) and refreshes itself. Treat it as a secret: the CLI is the only thing that reads it. `logout` deletes it.

`XAI_API_KEY` in the environment wins over the session.

**403 is a hard stop.** It means xAI did not give this subscription that call. Tell the person exactly that and wait; switching to an API key is their call. 401 means log in again.

## Speak

```bash
node "$GROK_VOICE" say "Hola, bienvenidos." -o hola.wav --language=es-ES --voice=carina
node "$GROK_VOICE" say - -o read.mp3 --language=en --voice=eve < script.txt
node "$GROK_VOICE" voices
```

Defaults: voice `eve`, language `auto`, speed 1, WAV 48 kHz. For Spanish pass `--language=es-ES` or `es-MX`; voices that work in Spanish: eve, ara, carina, rex, leo. Options: `--speed=0.7…1.5`, `--style=soft` or `slow+soft` (wraps the text in those tags), `--replace=Alumni=Álumni` (repeatable, fixes pronunciation).

Cap: 60,000 characters per request. Longer text goes through `batch`, split at sentence boundaries.

**Multi-line narration** uses `batch`, which only regenerates lines whose text or options changed:

```bash
node "$GROK_VOICE" batch lines.json --out=audio
node "$GROK_VOICE" batch lines.json --only=s01,s03 --force
```

`lines.json` is `[{ "id", "text", "voice"?, "language"?, "speed"?, "style"?, "replace"? }]`. Output: `<id>.wav` per line plus `manifest.json` (per-line duration, `order`, `totalDuration`).

**Speech tags** go inside the text. Fetch https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#speech-tags first and use only tags listed there. Two shapes: a point is square brackets (`[pause]`, `[laugh]`); a stretch of words is a wrapping pair (`<whisper>a secret</whisper>`, `<soft>`, `<slow>`, `<singing>`). Whisper is always the wrapping form. Wrap whole phrases, one inline tag at a time.

Done when the CLI printed the output path with a duration (or `batch` printed `Manifest: … total`) for every file asked for.

## Transcribe

```bash
node "$GROK_VOICE" transcribe audio.mp3
node "$GROK_VOICE" transcribe note.wav --language=es --format
node "$GROK_VOICE" transcribe call.m4a --language=es --keyterm=Mars --diarize --json
```

Stdout is the transcript. `--json` gives the full response (`text`, `language`, `duration`, `words` with `start`/`end`). `--format` writes numbers and amounts as digits and requires `--language`. `--diarize` tags a speaker on each word. `--filler-words` keeps "eh"/"um". `--keyterm` (repeatable) biases toward names.

Input: a container file — wav, mp3, m4a, ogg, opus, flac, webm, or mp4 — up to 500 MB. Convert raw PCM to wav with ffmpeg first.

Done when the transcript (or JSON) is printed and handed back or saved where asked.

## From Node

`import { synthesize, transcribeFile, listVoices, getAccessToken } from "<path>/scripts/grok-voice.mjs"`. `synthesize(opts)` returns `{ audio, params }` with WAV bytes; `transcribeFile(path, opts)` returns the `/v1/stt` JSON. Both refresh the session and retry 429/5xx on their own.
