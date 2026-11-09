# Grok voice inside an app

For a product (a reader, a dictation tool, a bot) the app calls xAI directly with that person's bearer and keeps the session in its own secret store. The bearer lives in the app's backend or native process, which opens every HTTP call and socket; the browser only ever talks to that process.

Official examples use an API key. A SuperGrok OAuth bearer from this login returned audio on `POST /v1/tts` and the TTS WebSocket (checked 2026-10-12), and the same bearer drives `wss://api.x.ai/v1/stt`. A 403 means that account is outside that result.

## Login (device code)

The client is the public Grok CLI client from Grok Build — not an account secret.

- `client_id`: `b1a00492-073a-47ea-816f-4c329264a828`
- `scope`: `openid profile email offline_access grok-cli:access api:access`

1. `POST https://auth.x.ai/oauth2/device/code`, form fields `client_id`, `scope`, `referrer`.
2. Show `verification_uri_complete` and `user_code`. Open the URL only when it is `https` on host `accounts.x.ai` or `auth.x.ai`.
3. Poll `POST https://auth.x.ai/oauth2/token`, form `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `client_id`, `device_code`. Wait `interval` before the first poll. `authorization_pending` → keep polling; `slow_down` → add 5 s.
4. Refresh: `grant_type=refresh_token`, `client_id`, `refresh_token`. When the response has no new refresh token, keep the old one. Serialize refreshes: two concurrent refreshes can invalidate each other.

## Text to speech

**One shot:** `POST https://api.x.ai/v1/tts`, `Authorization: Bearer …`, JSON body `text`, `language`, `voice_id`, and optionally `speed`, `output_format` (`codec`: wav, mp3, pcm, mulaw, alaw; `sample_rate`; `bit_rate` for mp3 only), `replace`, `with_timestamps`. Success body is raw audio; with `with_timestamps: true` it is JSON with base64 `audio`, `duration`, `audio_timestamps`. Cap 60,000 characters.

**Voices:** `GET https://api.x.ai/v1/tts/voices`.

**Live reading** (a "read this selection" feature):
`wss://api.x.ai/v1/tts?language=es-ES&voice=carina&codec=pcm&sample_rate=48000`, same bearer.

1. Optional pronunciations for the connection, before any text: send `{"type":"session.update","replace":{"Alumni":"Álumni"}}`, wait for `session.updated`.
2. Send `{"type":"text.delta","delta":"…"}` (as many as needed), then `{"type":"text.done"}`.
3. Receive `audio.delta` (base64) until `audio.done`.
4. Cancel mid-stream with `{"type":"text.clear"}`.

Languages, codecs, pronunciation (`replace`, IPA): https://docs.x.ai/developers/model-capabilities/audio/text-to-speech. List price when xAI bills the call: 15 USD per million characters.

## Speech to text

**File:** `POST https://api.x.ai/v1/stt` as `multipart/form-data`, same bearer. Append every field before `file` — the server can ignore fields that arrive after it. `model` = `grok-voice-transcribe-2.0`; optional `language`, `format` (requires `language`), `diarize`, `filler_words`, `keyterm` (once per name). Containers are detected; raw PCM also needs `audio_format` and `sample_rate`. Max 500 MB. Response: `text`, `language`, `duration`, `words` (each with `start`, `end`, and `speaker` when diarized).

**Live dictation** (hold-to-talk):
`wss://api.x.ai/v1/stt?model=grok-voice-transcribe-2.0&encoding=pcm&sample_rate=16000&interim_results=true&language=es`

1. Wait for `{"type":"transcript.created"}` before sending audio.
2. Send raw PCM, 16-bit little-endian mono, as binary frames — about 100 ms per frame (3200 bytes at 16 kHz), unencoded.
3. Read `transcript.partial`:
   - `is_final: false` — words may still change.
   - `is_final: true`, `speech_final: false` — chunk locked, person still talking.
   - both true — they paused; utterance done.
4. On push-to-talk release send `{"type":"finalize"}` and keep the socket open.
5. End of session: send `{"type":"audio.done"}`, wait for `transcript.done`, close.

The microphone stays in the app. Opus input, smart turn, and per-channel transcripts are query options documented at https://docs.x.ai/developers/model-capabilities/audio/speech-to-text — take names from there.

## Errors (TTS and STT)

- 401 — refresh once; if it fails again, log in again.
- 403 — this subscription did not get that call. Stop and tell the person.
- 400 — bad form or query (`format` without `language` is the common one).
- 404 — unknown voice; list voices.
- 413 — file over 500 MB.
- 429 / 5xx — retry a few times with backoff, honoring `Retry-After`.
