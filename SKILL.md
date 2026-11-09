---
name: grok-tts
description: >
  Speak and transcribe with the user's own Grok subscription (device OAuth, no API key)
  or with an xAI API key. Use for TTS, STT, voiceover, narration, dictation, voces,
  locución, transcripción, or to call Grok/xAI text-to-speech and speech-to-text
  from a script or an app. Also when the user runs /grok-tts.
---

# Grok TTS

Speech and transcription with the Grok account of whoever is at this machine. One browser approval covers both. The token stays on their disk.

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

If `XAI_API_KEY` is set, the CLI uses it. A 403 on the subscription token means this account did not get that voice call. Stop and say so. Do not switch to an API key unless the person asks.

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

Speech tags go inside `text`. Before writing any, read https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#speech-tags and use only tags from that section.

Two shapes. A point in the sentence is square brackets, as in `[pause]` or `[laugh]`. A stretch of words is a wrapping tag with a closing tag, as in `<whisper>a secret</whisper>`, `<soft>`, `<slow>`, or `<singing>`. Whisper is `<whisper>`, not `[whisper]`. Wrap a whole phrase. Do not stack several inline tags in a row. That page has the full list and a sample of each.

Cap: 60,000 characters per request. Split longer text into sentences.

From Node, import `synthesize`, `transcribeFile`, and `getAccessToken` from the script. `synthesize` returns `{ audio, params }` with WAV bytes. `transcribeFile` returns the JSON from `POST /v1/stt`.

## Transcribe a file

```bash
node "$GROK_TTS" transcribe audio.mp3
node "$GROK_TTS" transcribe note.wav --language=es --format
node "$GROK_TTS" transcribe note.wav --language=es --keyterm=Mars --diarize --json
```

Stdout is the transcript. `--json` prints the full response (`text`, `language`, `duration`, `words` with start and end). `--format` writes numbers and amounts as digits and needs `--language`. `--diarize` adds a speaker on each word. `--filler-words` keeps "eh" and "um". Repeat `--keyterm` for names the model should prefer.

Give the CLI a container: wav, mp3, m4a, ogg, opus, flac, webm, or mp4. Max 500 MB. It does not send raw PCM.

Languages, diarization, and the streaming query names: https://docs.x.ai/developers/model-capabilities/audio/speech-to-text

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

Errors for speech: 401, log in again. 403, stop and tell the person this subscription did not get that call. 404, unknown voice; list voices. 429 or 5xx, retry a few times with backoff.

Official docs show an API key in the examples. A SuperGrok OAuth bearer from this login returned audio on both `POST /v1/tts` and the TTS WebSocket (checked 2026-10-12). The same bearer is what a dictation app uses for `wss://api.x.ai/v1/stt`. A 403 means that account is outside that result. TTS list price, when xAI bills that call that way: 15 USD per million characters.

Languages, codecs, and pronunciation (`replace`, IPA): https://docs.x.ai/developers/model-capabilities/audio/text-to-speech

### Transcribe

File: `POST https://api.x.ai/v1/stt` as `multipart/form-data`, with the same Bearer. Put every field before `file`. The server can ignore fields that arrive after the file. Send `model` as `grok-voice-transcribe-2.0`. Optional: `language`, `format` (needs `language`), `diarize`, `filler_words`, and `keyterm` repeated once per name. The JSON response has `text`, `language`, `duration`, and `words` (each word has `start` and `end`; `speaker` when you asked for diarization). Containers are detected. Raw PCM also needs `audio_format` and `sample_rate`. Max 500 MB.

Live dictation, the shape of a hold-to-talk app:

`wss://api.x.ai/v1/stt?model=grok-voice-transcribe-2.0&encoding=pcm&sample_rate=16000&interim_results=true&language=es`

Wait for `{"type":"transcript.created"}` before any audio. Then send raw PCM, 16-bit little-endian, mono, as binary frames. About 100 ms per frame is 3200 bytes at 16 kHz. Do not base64-encode the audio.

`transcript.partial` is a line of text. `is_final` false means those words can still change. `is_final` true and `speech_final` false means that chunk is locked and the person is still going. Both true means they paused and the utterance is done. On a push-to-talk release, send `{"type":"finalize"}` and keep the socket. When the session is over, send `{"type":"audio.done"}`, wait for `transcript.done`, and close.

The microphone stays in the app. Opus packets, smart turn, and one transcript per channel are query options on the speech-to-text page. Read them there instead of inventing names: https://docs.x.ai/developers/model-capabilities/audio/speech-to-text

STT errors: 401, log in again. 403, stop. 400, the form or the query is wrong (`format` without `language` is a common one). 413, the file is over 500 MB. 429 or 5xx, retry a few times.

Do not put the bearer in a browser. The app process opens the HTTP call and the socket.
