#!/usr/bin/env bun
/**
 * Postinstall hook: download the `gws` (Google Workspace CLI) binary
 * for the host platform into `~/.membot/bin/`. The Google Docs / Sheets /
 * Slides source plugins shell out to this binary at runtime — we bundle
 * it so users don't have to install a separate dep alongside `bun add
 * -g membot`. Same shape as `@googleworkspace/cli`'s own npm wrapper:
 * fetch the matching release tarball from GitHub Releases, verify the
 * checksum, extract the binary into a known location.
 *
 * Idempotent: if a binary at the expected version is already present
 * (tracked via a `.gws.version` sidecar), the script is a no-op.
 *
 * Unsupported platforms (windows-arm64, anything else) log a single
 * warning and exit 0 — the runtime resolver in `src/ingest/gws.ts`
 * turns missing-binary into a `HelpfulError` only when a Google source
 * is actually used, so non-Google ingest keeps working.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GWS_BIN_NAME, GWS_VERSION } from "../src/constants.ts";

interface TargetSpec {
	asset: string;
	archive: "tar.gz" | "zip";
	binaryInArchive: string;
}

/**
 * Map `process.platform` + `process.arch` to the `gws` release asset
 * name. Returns null for platforms `gws` doesn't publish — currently
 * just windows-arm64.
 */
function targetForHost(): TargetSpec | null {
	const platform = process.platform;
	const arch = process.arch;
	if (platform === "darwin" && arch === "arm64") {
		return { asset: "google-workspace-cli-aarch64-apple-darwin.tar.gz", archive: "tar.gz", binaryInArchive: "gws" };
	}
	if (platform === "darwin" && arch === "x64") {
		return { asset: "google-workspace-cli-x86_64-apple-darwin.tar.gz", archive: "tar.gz", binaryInArchive: "gws" };
	}
	if (platform === "linux" && arch === "arm64") {
		return {
			asset: "google-workspace-cli-aarch64-unknown-linux-musl.tar.gz",
			archive: "tar.gz",
			binaryInArchive: "gws",
		};
	}
	if (platform === "linux" && arch === "x64") {
		return {
			asset: "google-workspace-cli-x86_64-unknown-linux-musl.tar.gz",
			archive: "tar.gz",
			binaryInArchive: "gws",
		};
	}
	if (platform === "win32" && arch === "x64") {
		return { asset: "google-workspace-cli-x86_64-pc-windows-msvc.zip", archive: "zip", binaryInArchive: "gws.exe" };
	}
	return null;
}

function membotHome(): string {
	const env = process.env.MEMBOT_HOME;
	if (env?.trim()) return env;
	return join(homedir(), ".membot");
}

async function downloadToFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
	}
	const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
	const out = createWriteStream(dest);
	await pipeline(body, out);
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`failed to fetch ${url}: HTTP ${response.status}`);
	return response.text();
}

function sha256OfFile(path: string): string {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

/**
 * Extract one archive into `outDir`. Shells out to the system `tar`
 * (every modern macOS/Linux and Windows 10 1803+ ships bsdtar). The
 * archive ships a single top-level `gws` binary, so we don't need
 * fancy member filtering — extract everything, then locate the
 * binary by name.
 */
async function unpackArchive(archive: string, outDir: string, kind: "tar.gz" | "zip"): Promise<void> {
	let cmd: string[];
	if (kind === "tar.gz") {
		cmd = ["tar", "-xzf", archive, "-C", outDir];
	} else if (process.platform === "win32") {
		cmd = [
			"powershell",
			"-NoProfile",
			"-Command",
			`Expand-Archive -Force -Path "${archive}" -DestinationPath "${outDir}"`,
		];
	} else {
		cmd = ["unzip", "-o", archive, "-d", outDir];
	}
	const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`extraction failed (${cmd[0]} exited ${code})`);
}

/**
 * Walk `outDir` and return the first file whose basename equals
 * `member`. gws release archives unpack a single binary at the top
 * level, but the tar layout has varied across versions — searching
 * is cheaper than guessing.
 */
async function locateExtractedBinary(outDir: string, member: string): Promise<string> {
	const { readdir } = await import("node:fs/promises");
	const stack: string[] = [outDir];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) break;
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name === member) return full;
		}
	}
	throw new Error(`extracted archive did not contain ${member}`);
}

async function main(): Promise<void> {
	const target = targetForHost();
	const home = membotHome();
	const binDir = join(home, "bin");
	const installed = join(binDir, GWS_BIN_NAME);
	const versionMarker = join(binDir, ".gws.version");

	if (!target) {
		console.warn(
			`[membot] skipping gws install: no prebuilt binary for ${process.platform}/${process.arch}. Google sources will not work on this host.`,
		);
		return;
	}

	if (existsSync(installed) && existsSync(versionMarker)) {
		const current = readFileSync(versionMarker, "utf8").trim();
		if (current === GWS_VERSION) {
			console.log(`[membot] gws ${GWS_VERSION} already installed at ${installed}`);
			return;
		}
	}

	mkdirSync(binDir, { recursive: true });

	const baseUrl = `https://github.com/googleworkspace/cli/releases/download/${GWS_VERSION}`;
	const archiveUrl = `${baseUrl}/${target.asset}`;
	const shaUrl = `${archiveUrl}.sha256`;

	const work = join(tmpdir(), `membot-gws-install-${Date.now()}`);
	mkdirSync(work, { recursive: true });

	try {
		const archivePath = join(work, target.asset);
		console.log(`[membot] downloading gws ${GWS_VERSION} (${target.asset})`);
		await downloadToFile(archiveUrl, archivePath);

		const shaText = await fetchText(shaUrl);
		const expected = shaText.trim().split(/\s+/)[0]?.toLowerCase();
		if (!expected) throw new Error(`empty checksum for ${target.asset}`);
		const actual = sha256OfFile(archivePath).toLowerCase();
		if (actual !== expected) {
			throw new Error(`checksum mismatch for ${target.asset}: expected ${expected}, got ${actual}`);
		}

		console.log(`[membot] extracting ${target.binaryInArchive}`);
		await unpackArchive(archivePath, work, target.archive);
		const extracted = await locateExtractedBinary(work, target.binaryInArchive);

		if (existsSync(installed)) rmSync(installed);
		writeFileSync(installed, readFileSync(extracted));
		chmodSync(installed, 0o755);
		const size = statSync(installed).size;
		writeFileSync(versionMarker, `${GWS_VERSION}\n`);
		console.log(`[membot] installed gws ${GWS_VERSION} → ${installed} (${size} bytes)`);
	} finally {
		try {
			rmSync(work, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
}

await main();
