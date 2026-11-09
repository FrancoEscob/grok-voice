# grok-tts

Agent skill and CLI for speech and transcription with a [Grok](https://x.ai) subscription. One browser login covers both. No API key required. An `XAI_API_KEY` in the environment still works.

The same calls are what an app needs for one-shot audio, live reading, a file transcript, or live dictation. Agents follow [SKILL.md](SKILL.md).

## Requirements

- Node 20 or newer
- ffmpeg, only to write mp3, m4a, or ogg, or to print durations

## Install

Grok Build:

```bash
git clone https://github.com/FrancoEscob/grok-tts.git ~/.grok/skills/grok-tts
```

Claude Code, Codex, or another agent that reads `SKILL.md` from a skills directory: clone the repo into that directory (`~/.claude/skills/grok-tts`, `~/.codex/skills/grok-tts`, `~/.agents/skills/grok-tts`).

Optional, on your PATH:

```bash
ln -sf ~/.grok/skills/grok-tts/scripts/grok-tts.mjs ~/.local/bin/grok-tts
chmod +x ~/.grok/skills/grok-tts/scripts/grok-tts.mjs
```

## CLI

```bash
grok-tts login
grok-tts say "Hola." -o hola.wav --language=es-ES --voice=carina
grok-tts voices
grok-tts batch lines.json --out=audio
grok-tts transcribe note.wav --language=es --format
```

`login` prints a URL. Approve it in the browser once. The session is stored at `~/.config/grok-tts/auth.json` (mode 600) and refreshed on use. It is never printed.

`lines.json` is an array of `{ "id", "text", "voice"?, "language"?, "speed"?, "style"?, "replace"? }`.

## In an app

Do not shell out. Use the device login, `POST https://api.x.ai/v1/tts`, `POST https://api.x.ai/v1/stt`, and the two WebSockets described in [SKILL.md](SKILL.md). Store the token in the app's own secret store.

This project is not affiliated with xAI. Voice on a subscription is an account decision on xAI's side. If a call returns 403, that subscription did not get it.
