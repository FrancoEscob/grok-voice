#!/usr/bin/env node
// grok-tts: spoken audio from the user's own Grok subscription, or XAI_API_KEY.
//
// One device-code login (the same public Grok client Grok Build uses). The
// session is refreshed automatically. Credentials live in
// ~/.config/grok-tts/auth.json (mode 600) and are never printed.
//
//   grok-tts login [--no-open]
//   grok-tts status
//   grok-tts say "Hello" -o hello.wav [--voice=eve] [--language=auto] [--speed=1]
//                              [--style=soft] [--replace=Alumni=Álumni]
//   grok-tts batch lines.json [--out=dir] [--only=a,b] [--force]
//   grok-tts voices
//   grok-tts transcribe audio.mp3 [--language=es] [--format] [--diarize] [--json]
//   grok-tts logout
//
// batch reads [{ "id", "text", "voice"?, "language"?, "speed"?, "style"?, "replace"? }]
// and writes <out>/<id>.wav plus <out>/manifest.json. A line is regenerated only
// when its text or options changed (or always with --force).
//
// From another script:
//   import { synthesize, transcribeFile, getAccessToken } from "./grok-tts.mjs";

import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Public Grok CLI client id (Apache-2.0 grok-build, crate xai-grok-login). Not an account secret.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const API_BASE = "https://api.x.ai/v1";

const AUTH_PATH = process.env.GROK_TTS_AUTH ?? join(homedir(), ".config", "grok-tts", "auth.json");
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const OUTPUT_FORMAT = { codec: "wav", sample_rate: 48_000 };
const MAX_CHARS = 60_000;
const MAX_STT_BYTES = 500 * 1024 * 1024;
const STT_MODEL = "grok-voice-transcribe-2.0";

export const DEFAULTS = Object.freeze({ voice: "eve", language: "auto", speed: 1 });

export class AuthError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readCredential() {
	try {
		const data = JSON.parse(await readFile(AUTH_PATH, "utf8"));
		return data?.access && data?.refresh ? data : null;
	} catch {
		return null;
	}
}

async function writeCredential(cred) {
	await mkdir(dirname(AUTH_PATH), { recursive: true, mode: 0o700 });
	const tmp = `${AUTH_PATH}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
	await chmod(tmp, 0o600);
	await rename(tmp, AUTH_PATH);
}

// Two processes must not refresh at once and invalidate each other's refresh token.
async function withLock(fn) {
	const lock = `${AUTH_PATH}.lock`;
	await mkdir(dirname(AUTH_PATH), { recursive: true, mode: 0o700 });
	for (let attempt = 0; ; attempt++) {
		try {
			await (await open(lock, "wx", 0o600)).close();
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const info = await stat(lock).catch(() => null);
			if (info && Date.now() - info.mtimeMs > 30_000) {
				await rm(lock, { force: true });
				continue;
			}
			if (attempt > 150) throw new Error(`Lock still held: ${lock}`);
			await sleep(200);
		}
	}
	try {
		return await fn();
	} finally {
		await rm(lock, { force: true });
	}
}

async function postForm(url, fields) {
	const response = await fetch(url, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields),
	});
	let body = {};
	try {
		body = (await response.json()) ?? {};
	} catch {
		throw new Error(`xAI OAuth returned non-JSON (HTTP ${response.status}).`);
	}
	return { ok: response.ok, status: response.status, body };
}

function credentialFrom(body, previousRefresh) {
	if (typeof body.access_token !== "string" || !body.access_token) throw new Error("xAI did not return an access_token.");
	const refresh = body.refresh_token ?? previousRefresh;
	if (!refresh) throw new Error("xAI did not return a refresh_token.");
	const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
	return { type: "oauth", access: body.access_token, refresh, expires: Date.now() + lifetime * 1000 - REFRESH_SKEW_MS };
}

function assertVerificationUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("xAI returned a verification URL that is not a URL.");
	}
	const portOk = url.port === "" || url.port === "443";
	const hostOk = url.hostname === "accounts.x.ai" || url.hostname === "auth.x.ai";
	if (url.protocol !== "https:" || !portOk || !hostOk || url.username || url.password) {
		throw new Error("xAI returned a verification URL that is not https on accounts.x.ai or auth.x.ai.");
	}
	return url;
}

function openBrowser(url) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
	} catch {
		// The URL is already printed. Opening the browser is optional.
	}
}

/** Valid access token. XAI_API_KEY wins when set. Otherwise the saved session, refreshed if needed. */
export async function getAccessToken({ forceRefresh = false } = {}) {
	if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
	const cred = await readCredential();
	if (!cred) throw new AuthError("No xAI session. Run: grok-tts login");
	if (!forceRefresh && Date.now() < cred.expires) return cred.access;
	return withLock(async () => {
		const current = await readCredential();
		if (!current) throw new AuthError("No xAI session. Run: grok-tts login");
		// Another process may have refreshed while we waited for the lock.
		if (current.access !== cred.access && Date.now() < current.expires) return current.access;
		if (!forceRefresh && Date.now() < current.expires) return current.access;
		const response = await postForm(TOKEN_URL, { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: current.refresh });
		if (!response.ok) {
			const detail = [response.body.error, response.body.error_description].filter(Boolean).join(": ");
			throw new AuthError(`xAI session expired or was revoked (${detail || response.status}). Run: grok-tts login`);
		}
		const fresh = credentialFrom(response.body, current.refresh);
		await writeCredential(fresh);
		return fresh.access;
	});
}

export async function login({ openBrowser: shouldOpen = true, log = console.log } = {}) {
	const device = await postForm(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE, referrer: "grok-tts" });
	if (!device.ok) throw new Error(`xAI did not issue a device code (HTTP ${device.status}).`);
	const { device_code: deviceCode, user_code: userCode, verification_uri: uri, verification_uri_complete: uriComplete } = device.body;
	const url = assertVerificationUrl(uriComplete || uri);
	log(`Open this page and approve access:\n  ${url.href}\nCode: ${userCode}`);
	if (shouldOpen) openBrowser(url.href);
	let interval = Math.max(Number(device.body.interval) || 5, 1);
	const deadline = Date.now() + (Number(device.body.expires_in) || 600) * 1000;
	while (Date.now() < deadline) {
		await sleep(interval * 1000);
		const poll = await postForm(TOKEN_URL, {
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			client_id: CLIENT_ID,
			device_code: deviceCode,
		});
		if (poll.ok) {
			await writeCredential(credentialFrom(poll.body));
			log("Signed in. Session saved.");
			return;
		}
		const error = poll.body.error;
		if (error === "authorization_pending") continue;
		if (error === "slow_down") {
			interval = Number(poll.body.interval) || interval + 5;
			continue;
		}
		if (error === "access_denied" || error === "authorization_denied") throw new Error("Access was denied in the browser.");
		if (error === "expired_token") throw new Error("The code expired. Run grok-tts login again.");
		throw new Error(`xAI OAuth failed (HTTP ${poll.status}): ${error ?? ""} ${poll.body.error_description ?? ""}`.trim());
	}
	throw new Error("The code expired before it was approved. Run grok-tts login again.");
}

async function apiError(response) {
	const body = await response.text().catch(() => "");
	try {
		const json = JSON.parse(body);
		return json.error?.message ?? json.error ?? json.message ?? body.slice(0, 300);
	} catch {
		return body.slice(0, 300);
	}
}

// 401 refreshes the session once and retries. 403 means this account did not get that call.
async function xai(path, init = {}) {
	for (let attempt = 0, refreshed = false; ; attempt++) {
		const token = await getAccessToken({ forceRefresh: refreshed && attempt === 1 });
		const response = await fetch(`${API_BASE}${path}`, {
			...init,
			headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
		});
		if (response.ok) return response;
		if (response.status === 401 && !refreshed && !process.env.XAI_API_KEY) {
			refreshed = true;
			attempt = 0;
			await response.body?.cancel().catch(() => {});
			continue;
		}
		if (response.status === 401)
			throw new AuthError(`xAI rejected the credential (401): ${await apiError(response)}. Run: grok-tts login`);
		if (response.status === 403)
			throw new AuthError(`xAI refused ${path} for this account (403): ${await apiError(response)}. This subscription did not get that call; logging in again will not change it.`);
		if ((response.status === 429 || response.status >= 500) && attempt < 4) {
			const retryAfter = Number(response.headers.get("retry-after"));
			const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 2 ** attempt * 1500;
			console.warn(`  xAI responded ${response.status}; retry in ${wait / 1000}s`);
			await response.body?.cancel().catch(() => {});
			await sleep(wait);
			continue;
		}
		throw new Error(`xAI ${path} failed (${response.status}): ${await apiError(response)}`);
	}
}

function applyReplace(text, replace) {
	if (!replace) return text;
	let out = text;
	for (const [from, to] of Object.entries(replace)) out = out.split(from).join(to);
	return out;
}

// "soft" → <soft>…</soft>; "slow+soft" nests both.
function applyStyle(text, style) {
	if (!style) return text;
	return style
		.split(/[+,\s]+/)
		.filter(Boolean)
		.reduceRight((inner, tag) => `<${tag}>${inner}</${tag}>`, text);
}

/** Returns { audio: Buffer (WAV 48 kHz), params }. */
export async function synthesize({ text, voice, language, speed, style, replace } = {}) {
	if (!text?.trim()) throw new Error("Missing text.");
	const finalText = applyStyle(applyReplace(text, replace), style);
	if (finalText.length > MAX_CHARS) throw new Error(`Text is over ${MAX_CHARS} characters.`);
	const params = {
		text: finalText,
		voice_id: voice ?? DEFAULTS.voice,
		language: language ?? DEFAULTS.language,
		speed: speed ?? DEFAULTS.speed,
		output_format: OUTPUT_FORMAT,
	};
	const response = await xai("/tts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(params),
	});
	return { audio: Buffer.from(await response.arrayBuffer()), params };
}

export async function listVoices() {
	const { voices } = await (await xai("/tts/voices")).json();
	return voices ?? [];
}

/** Transcribe a container file (wav, mp3, m4a, …). Returns the JSON from POST /v1/stt. */
export async function transcribeFile(file, { language, format = false, diarize = false, fillerWords = false, keyterms = [] } = {}) {
	if (format && !language) throw new Error("--format needs --language.");
	const info = await stat(file);
	if (!info.isFile()) throw new Error(`${file} is not a file.`);
	if (info.size > MAX_STT_BYTES) throw new Error("File is over 500 MB.");
	const form = new FormData();
	// Fields first: the server can ignore fields that arrive after the file.
	form.append("model", STT_MODEL);
	if (language) form.append("language", language);
	if (format) form.append("format", "true");
	if (diarize) form.append("diarize", "true");
	if (fillerWords) form.append("filler_words", "true");
	for (const term of keyterms) form.append("keyterm", term);
	form.append("file", new Blob([await readFile(file)]), basename(file));
	return (await xai("/stt", { method: "POST", body: form })).json();
}

async function durationOf(path) {
	try {
		const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path]);
		return Math.round(Number(stdout.trim()) * 1000) / 1000;
	} catch {
		return null;
	}
}

// WAV is stored as returned. A .mp3/.m4a/.ogg path is transcoded with ffmpeg.
async function saveAudio(audio, file) {
	await mkdir(dirname(file), { recursive: true });
	const ext = extname(file).toLowerCase();
	if (ext === ".wav" || ext === "") {
		await writeFile(`${file}.tmp`, audio);
		await rename(`${file}.tmp`, file);
		return;
	}
	const tmp = `${file}.tmp.wav`;
	await writeFile(tmp, audio);
	try {
		await execFileAsync("ffmpeg", ["-v", "error", "-y", "-i", tmp, file]);
	} finally {
		await rm(tmp, { force: true });
	}
}

function parseArgs(argv) {
	const opts = { positional: [], replace: {}, keyterms: [], force: false, open: true };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--force") opts.force = true;
		else if (arg === "--no-open") opts.open = false;
		else if (arg === "--format") opts.format = true;
		else if (arg === "--json") opts.json = true;
		else if (arg === "--diarize") opts.diarize = true;
		else if (arg === "--filler-words") opts.fillerWords = true;
		else if (arg === "-o") {
			opts.out = argv[++i];
			if (!opts.out) throw new Error("-o needs a file path.");
		} else if (arg === "-h" || arg === "--help") opts.help = true;
		else if (arg.startsWith("--")) {
			const [key, ...rest] = arg.slice(2).split("=");
			const value = rest.join("=");
			if (!value) throw new Error(`Missing value for ${arg} (use --${key}=value).`);
			if (key === "replace") {
				const [from, ...to] = value.split("=");
				opts.replace[from] = to.join("=");
			} else if (key === "keyterm") opts.keyterms.push(value);
			else if (key === "speed") {
				opts.speed = Number(value);
				if (!(opts.speed >= 0.7 && opts.speed <= 1.5)) throw new Error("--speed must be a number from 0.7 to 1.5.");
			}
			else if (key === "only") opts.only = new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
			else if (["voice", "language", "style", "out"].includes(key)) opts[key] = value;
			else throw new Error(`Unknown option: --${key}`);
		} else opts.positional.push(arg);
	}
	if (!Object.keys(opts.replace).length) delete opts.replace;
	return opts;
}

const lineOptions = (opts, line = {}) => ({
	voice: line.voice ?? opts.voice,
	language: line.language ?? opts.language,
	speed: line.speed ?? opts.speed,
	style: line.style ?? opts.style,
	replace: { ...(opts.replace ?? {}), ...(line.replace ?? {}) },
});

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

async function cmdSay(opts) {
	let text = opts.positional.join(" ");
	if (!text || text === "-") {
		if (process.stdin.isTTY) throw new Error('Missing text. Use: grok-tts say "text" or pipe it with say -');
		text = await readStdin();
	}
	const file = resolve(opts.out ?? `grok-tts-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`);
	const { audio, params } = await synthesize({ text, ...lineOptions(opts) });
	await saveAudio(audio, file);
	const duration = await durationOf(file);
	console.log(`${file} (${params.voice_id}, ${params.language}${duration ? `, ${duration} s` : ""})`);
}

async function cmdBatch(opts) {
	const input = resolve(opts.positional[0] ?? "narration.json");
	const outDir = resolve(opts.out ?? join(dirname(input), "audio"));
	const lines = JSON.parse(await readFile(input, "utf8"));
	if (!Array.isArray(lines)) throw new Error(`${input} must be an array of lines.`);
	for (const line of lines) if (!line?.id || !line?.text) throw new Error(`Line missing id or text: ${JSON.stringify(line)}`);
	const ids = new Set();
	for (const { id } of lines) {
		if (ids.has(id)) throw new Error(`Duplicate line id: ${id}`);
		ids.add(id);
	}
	const unknown = [...(opts.only ?? [])].filter((id) => !lines.some((l) => l.id === id));
	if (unknown.length) throw new Error(`--only ids that do not exist: ${unknown.join(", ")}`);

	await mkdir(outDir, { recursive: true });
	const manifestPath = join(outDir, "manifest.json");
	const manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : {};
	manifest.lines ??= {};
	// Lines removed from the script drop out of the manifest and the total.
	for (const id of Object.keys(manifest.lines)) if (!ids.has(id)) delete manifest.lines[id];

	for (const line of lines) {
		if (opts.only && !opts.only.has(line.id)) continue;
		const file = join(outDir, `${line.id}.wav`);
		const options = lineOptions(opts, line);
		const settings = { voice: options.voice ?? DEFAULTS.voice, language: options.language ?? DEFAULTS.language, speed: options.speed ?? DEFAULTS.speed, style: options.style ?? null, replace: options.replace };
		const key = JSON.stringify({ text: line.text, ...settings });
		const previous = manifest.lines[line.id];
		if (existsSync(file) && previous?.key === key && !opts.force) {
			console.log(`= ${line.id}`);
		} else {
			const { audio } = await synthesize({ text: line.text, ...options });
			await saveAudio(audio, file);
			manifest.lines[line.id] = { file: `${line.id}.wav`, text: line.text, ...settings, key };
			console.log(`+ ${line.id}`);
		}
		manifest.lines[line.id].duration = await durationOf(file);
	}
	manifest.format = OUTPUT_FORMAT;
	manifest.order = lines.map((l) => l.id);
	manifest.totalDuration = Math.round(Object.values(manifest.lines).reduce((sum, l) => sum + (l.duration ?? 0), 0) * 1000) / 1000;
	await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
	await rename(`${manifestPath}.tmp`, manifestPath);
	console.log(`Manifest: ${manifestPath} (${manifest.totalDuration}s total)`);
}

async function cmdTranscribe(opts) {
	const file = opts.positional[0];
	if (!file) throw new Error("Missing audio file.");
	const result = await transcribeFile(resolve(file), {
		language: opts.language,
		format: opts.format,
		diarize: opts.diarize,
		fillerWords: opts.fillerWords,
		keyterms: opts.keyterms,
	});
	if (opts.json) console.log(JSON.stringify(result, null, 2));
	else console.log(result.text ?? "");
}

async function cmdStatus() {
	if (process.env.XAI_API_KEY) return console.log("Using XAI_API_KEY from the environment.");
	const cred = await readCredential();
	if (!cred) return console.log("No session. Run: grok-tts login");
	const minutes = Math.round((cred.expires - Date.now()) / 60_000);
	console.log(minutes > 0 ? `Session saved. Access token expires in ${minutes} min and refreshes on use.` : "Session saved. Access token expired; it refreshes on use.");
}

const HELP = `grok-tts: speech and transcription with a Grok subscription, or with XAI_API_KEY.

  grok-tts login [--no-open]
  grok-tts status
  grok-tts say "text" [-o out.wav|.mp3] [--voice=${DEFAULTS.voice}] [--language=${DEFAULTS.language}] [--speed=1] [--style=soft] [--replace=From=To]
  grok-tts batch lines.json [--out=dir] [--only=a,b] [--force]
  grok-tts voices
  grok-tts transcribe audio.mp3 [--language=es] [--format] [--diarize] [--filler-words] [--keyterm=Name] [--json]
  grok-tts logout

Speech tags: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#speech-tags
Transcription: https://docs.x.ai/developers/model-capabilities/audio/speech-to-text`;

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	const opts = parseArgs(rest);
	if (opts.help) return console.log(HELP);
	if (command === "login") return login({ openBrowser: opts.open });
	if (command === "status") return cmdStatus();
	if (command === "logout") {
		await rm(AUTH_PATH, { force: true });
		return console.log("Session deleted.");
	}
	if (command === "say") return cmdSay(opts);
	if (command === "batch") return cmdBatch(opts);
	if (command === "transcribe") return cmdTranscribe(opts);
	if (command === "voices") {
		for (const v of await listVoices()) console.log(`${String(v.voice_id).padEnd(12)} ${v.gender ?? ""}\t${v.language ?? ""}\t${v.description ?? ""}`);
		return;
	}
	console.log(HELP);
	if (command && command !== "help") {
		console.error(`\nUnknown command: ${command}`);
		process.exitCode = 1;
	}
}

const invokedDirectly = (() => {
	try {
		return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();

if (invokedDirectly) {
	main().catch((error) => {
		console.error(error instanceof AuthError ? `Auth: ${error.message}` : `Error: ${error.message}`);
		process.exit(1);
	});
}
