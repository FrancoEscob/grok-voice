---
name: grok-tts
description: >
  Generate spoken audio with the user's own Grok subscription (device OAuth, no API key)
  or with an xAI API key. Use for TTS, voiceover, narration, voces, locución, or to call
  Grok/xAI text-to-speech from a script or an app. Also when the user runs /grok-tts.
---

# Grok TTS

Speech with the Grok account of whoever is at this machine. One browser approval. The token stays on their disk.

CLI: `scripts/grok-tts.mjs` next to this file. Node 20 or newer. ffmpeg only to transcode or to measure duration.

Find the script in this order:

```bash
GROK_TTS="${GROK_TTS_HOME:-$HOME/.grok/skills/grok-tts}/scripts/grok-tts.mjs"
[ -f "$GROK_TTS" ] || GROK_TTS="$HOME/.claude/skills/grok-tts/scripts/grok-tts.mjs"
[ -f "$GROK_TTS" ] || GROK_TTS="$HOME/.codex/skills/grok-tts/scripts/grok-tts.mjs"
[ -f "$GROK_TTS" ] || GROK_TTS="$HOME/.agents/skills/grok-tts/scripts/grok-tts.mjs"
node "$GROK_TTS" status
```

Inside this repo, run `scripts/grok-tts.mjs` directly.

## Session

```bash
node "$GROK_TTS" login
node "$GROK_TTS" login --no-open
node "$GROK_TTS" status
node "$GROK_TTS" logout
```

Show the person the URL and the code as soon as they print. Wait until login exits. Do not approve it yourself and do not invent a token.

Session file: `~/.config/grok-tts/auth.json` (mode 600). Do not print it, commit it, copy it from another machine, or read `~/.grok/auth.json`.

If `XAI_API_KEY` is set, the CLI uses it. A 403 on the subscription token means this account did not get TTS. Stop and say so. Do not switch to an API key unless the person asks.

## Audio files

```bash
node "$GROK_TTS" say "Hola." -o hola.wav --language=es-ES --voice=carina
node "$GROK_TTS" say - -o read.mp3 --language=en --voice=eve < script.txt
node "$GROK_TTS" voices
node "$GROK_TTS" batch lines.json --out=audio
node "$GROK_TTS" batch lines.json --only=s01,s03 --force
```

`batch` reads `[{ "id", "text", "voice"?, "language"?, "speed"?, "style"?, "replace"? }]`. It writes `<id>.wav` and `manifest.json`, and regenerates a line only when its text or options changed.

Defaults: voice `eve`, language `auto`, speed 1, WAV 48 kHz. For Spanish pass `--language=es-ES` or `es-MX`. Voices that work in Spanish: eve, ara, carina, rex, leo.

Also: `--speed` (0.7–1.5), `--style=soft` or `slow+soft` (wraps the text in `<soft>` / `<slow>`), `--replace=Alumni=Álumni` (repeatable).

Inside the text, use sparingly: `[pause]` `[long-pause]` `[laugh]` `[chuckle]` `[breath]` `<slow>` `<fast>` `<soft>` `<whisper>`. `<emphasis>` barely does anything.

Cap: 60,000 characters per request. Split longer text into sentences.

From Node, import `synthesize` and `getAccessToken` from the script. `synthesize` returns `{ audio, params }` with WAV bytes.

## In an app

Do not shell out when the product is an app (a reader, a dictation tool, a bot). Call the API with that person's bearer and store the session in the app's own secret store.

Login uses the public Grok CLI client (the one in Grok Build). It is not an account secret.

- `client_id`: `b1a00492-073a-47ea-816f-4c329264a828`
- `scope`: `openid profile email offline_access grok-cli:access api:access`
- `POST https://auth.x.ai/oauth2/device/code` as a form: `client_id`, `scope`, `referrer`
- Show `verification_uri_complete` and `user_code`. Open the URL only when it is `https` and the host is `accounts.x.ai` or `auth.x.ai`.
- `POST https://auth.x.ai/oauth2/token` as a form: `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `client_id`, `device_code`. Wait `interval` before the first poll. `authorization_pending` continues. `slow_down` adds 5 seconds.
- Refresh: `grant_type=refresh_token`, `client_id`, `refresh_token`. If the response has no new refresh token, keep the old one.

One-shot audio: `POST https://api.x.ai/v1/tts` with `Authorization: Bearer`. JSON body: `text`, `language`, `voice_id`, and when needed `speed`, `output_format` (`codec` wav, mp3, pcm, mulaw, or alaw; `sample_rate`; `bit_rate` for mp3 only), `replace`, `with_timestamps`. The body of a success is raw audio. With `with_timestamps: true` it is JSON: base64 `audio`, `duration`, `audio_timestamps`.

List voices: `GET https://api.x.ai/v1/tts/voices`.

Live reading, the way a "read this selection" feature works:

`wss://api.x.ai/v1/tts?language=es-ES&voice=carina&codec=pcm&sample_rate=48000` with the same Bearer. Send `{"type":"text.delta","delta":"..."}` then `{"type":"text.done"}`. The server sends `audio.delta` (base64) and `audio.done`. Cancel with `{"type":"text.clear"}`. Pronunciations for the connection, before any text: `{"type":"session.update","replace":{"Alumni":"Álumni"}}`, then wait for `session.updated`.

Errors: 401, log in again. 403, stop and tell the person this subscription did not get TTS. 404, unknown voice; list voices. 429 or 5xx, retry a few times with backoff.

Official docs show an API key in the examples. A SuperGrok OAuth bearer from this login returned audio on both `POST /v1/tts` and the WebSocket (checked 2026-10-12). A 403 means that account is outside that result. API list price, when xAI bills the call that way: 15 USD per million characters.

Full tag, language, and codec list: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech

Do not put the bearer in a browser. The app process requests the audio.
