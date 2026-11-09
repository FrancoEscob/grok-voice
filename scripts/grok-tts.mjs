#!/usr/bin/env node
// Old name, kept so existing scripts and symlinks keep working. Use grok-voice.mjs.
import { isMain, runCli } from "./grok-voice.mjs";
export * from "./grok-voice.mjs";

if (isMain(import.meta.url)) runCli();
