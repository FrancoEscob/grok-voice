# grok-voice

Agent skill and CLI for speech and transcription with a [Grok](https://x.ai) subscription. One browser login covers both. No API key required. An `XAI_API_KEY` in the environment still works.

The same calls are what an app needs for one-shot audio, live reading, a file transcript, or live dictation. Agents follow [SKILL.md](SKILL.md); app builders read [references/app-api.md](references/app-api.md).

## Requirements

- Node 20 or newer
- ffmpeg, only to write mp3, m4a, or ogg, or to print durations

## Install

Grok Build:

```bash
git clone https://github.com/FrancoEscob/grok-voice.git ~/.grok/skills/grok-voice
```

Claude Code, Codex, or another agent that reads `SKILL.md` from a skills directory: clone the repo into that directory (`~/.claude/skills/grok-voice`, `~/.codex/skills/grok-voice`, `~/.agents/skills/grok-voice`).

Optional, on your PATH:

```bash
ln -sf ~/.grok/skills/grok-voice/scripts/grok-voice.mjs ~/.local/bin/grok-voice
chmod +x ~/.grok/skills/grok-voice/scripts/grok-voice.mjs
```

## CLI

```bash
grok-voice login
grok-voice say "Hola." -o hola.wav --language=es-ES --voice=carina
grok-voice voices
grok-voice batch lines.json --out=audio
grok-voice transcribe note.wav --language=es --format
```

`login` prints a URL. Approve it in the browser once. The session is stored at `~/.config/grok-voice/auth.json` (mode 600) and refreshed on use. It is never printed.

`lines.json` is an array of `{ "id", "text", "voice"?, "language"?, "speed"?, "style"?, "replace"? }`. Re-running `batch` only regenerates lines whose text or options changed.

## In an app

Call the API from the app itself: device login, `POST https://api.x.ai/v1/tts`, `POST https://api.x.ai/v1/stt`, and the two WebSockets, all in [references/app-api.md](references/app-api.md). Keep the token in the app's own secret store.

Formerly `grok-tts`. Old clones, `scripts/grok-tts.mjs`, and sessions saved in `~/.config/grok-tts/` keep working.

This project is not affiliated with xAI. Voice on a subscription is an account decision on xAI's side. If a call returns 403, that subscription did not get it.
