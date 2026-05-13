import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FILES, GWS_BIN_NAME } from "../constants.ts";
import { HelpfulError } from "../errors.ts";

/**
 * Subprocess wrapper around the bundled `gws` (Google Workspace CLI)
 * binary. The Google Docs / Sheets / Slides source plugins call
 * `gwsExport` to fetch a Drive file as bytes; `membot login` calls
 * `gwsAuthSetup` to drive the one-time interactive OAuth flow.
 *
 * Why a CLI subprocess instead of a native client library: we deliberately
 * avoid maintaining a Google API client + OAuth flow inside membot.
 * `gws` already implements the dynamic-discovery Drive surface, refresh
 * tokens encrypted in the OS keyring, and the consent-screen browser
 * dance — bundling its binary (~6 MB) is cheaper and safer than
 * reimplementing it here.
 */

/** Resolved path of the `gws` binary, or null if it isn't installed on this host. */
export function resolveGwsBinary(): string | null {
	const override = process.env.MEMBOT_GWS_PATH;
	if (override?.trim()) {
		return existsSync(override) ? override : null;
	}
	const home = process.env.MEMBOT_HOME?.trim() || join(homedir(), ".membot");
	const bundled = join(home, FILES.BIN_DIR, GWS_BIN_NAME);
	if (existsSync(bundled)) return bundled;
	return null;
}

/**
 * Locate `gws`, or throw a `HelpfulError` naming the next step. Used
 * by every caller in this module so the missing-binary message stays
 * consistent.
 */
function requireGws(): string {
	const path = resolveGwsBinary();
	if (path) return path;
	throw new HelpfulError({
		kind: "internal_error",
		message: `gws binary not found at ${join(process.env.MEMBOT_HOME ?? `${homedir()}/.membot`, FILES.BIN_DIR, GWS_BIN_NAME)}`,
		hint: "Reinstall membot (`bun add -g membot`) to re-run the postinstall, or set MEMBOT_GWS_PATH to a manually-installed gws binary.",
	});
}

export interface GwsExportRequest {
	fileId: string;
	mimeType: string;
}

/**
 * Run `gws drive files export --params '{"fileId":...,"mimeType":...}'`
 * against the bundled binary and return the exported bytes. `gws`
 * writes binary output via `-o <path>`; we hand it a tempfile, read
 * the bytes back, and clean up.
 */
export async function gwsExport(req: GwsExportRequest): Promise<Buffer> {
	const bin = requireGws();
	const work = mkdtempSync(join(tmpdir(), "membot-gws-"));
	const outPath = join(work, "export.bin");
	try {
		const params = JSON.stringify({ fileId: req.fileId, mimeType: req.mimeType });
		const proc = Bun.spawn([bin, "drive", "files", "export", "--params", params, "-o", outPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderrText, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

		if (exitCode === 0) {
			if (!existsSync(outPath)) {
				throw new HelpfulError({
					kind: "internal_error",
					message: `gws drive files export exited 0 but produced no output file (fileId=${req.fileId})`,
					hint: "Re-run with `MEMBOT_DEBUG=1`, or invoke `gws drive files export` directly to inspect the failure.",
				});
			}
			return readFileSync(outPath);
		}

		throw translateGwsExitError(exitCode, stderrText, req);
	} finally {
		try {
			rmSync(work, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
}

/**
 * Map `gws`'s structured exit codes (documented in its README) to a
 * `HelpfulError` whose hint names the concrete next step. Exit code 2
 * is the "no credentials / expired" signal — the one we care most
 * about, since users will hit it during first run.
 */
function translateGwsExitError(exitCode: number | null, stderr: string, req: GwsExportRequest): HelpfulError {
	const trimmed = (stderr ?? "").trim();
	if (exitCode === 2) {
		return new HelpfulError({
			kind: "auth_error",
			message: `gws reported missing or invalid credentials while exporting ${req.fileId}: ${trimmed || "(no stderr)"}`,
			hint: "Run `membot login` to authenticate with Google (this delegates to `gws auth setup`).",
		});
	}
	if (/accessNotConfigured|API.*not.*enabled/i.test(trimmed)) {
		return new HelpfulError({
			kind: "auth_error",
			message: `Google rejected the export because the Drive API isn't enabled in your GCP project: ${trimmed}`,
			hint: "Run `gws auth setup` (or open your GCP console) to enable the Drive API for the OAuth client membot uses.",
		});
	}
	if (/(exceeds|too large|10\s*MB|10000000)/i.test(trimmed)) {
		return new HelpfulError({
			kind: "network_error",
			message: `Google's Drive export endpoint refused ${req.fileId} as too large (10 MB cap): ${trimmed}`,
			hint: "Download the file as its native format in a browser and re-ingest the local file with `membot add <path>`.",
		});
	}
	return new HelpfulError({
		kind: "network_error",
		message: `gws drive files export failed (exit ${exitCode ?? "?"}): ${trimmed || "(no stderr)"}`,
		hint: "Re-run; if the failure persists, invoke `gws drive files export --params '...'` directly to see the underlying error.",
	});
}

/**
 * Run `gws auth setup` interactively (inherited stdio) for the user's
 * first-time setup. Resolves to the exit code so the calling command
 * can surface a clean message rather than letting `gws`'s own output
 * speak for itself.
 */
export async function gwsAuthSetup(): Promise<number> {
	const bin = requireGws();
	const proc = Bun.spawn([bin, "auth", "setup"], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
	const code = await proc.exited;
	return code ?? 0;
}

/**
 * Run `gws auth login` interactively. Used when the user already has a
 * `client_secret.json` configured under `~/.config/gws/` and just needs
 * to refresh the OAuth token — a lighter version of `gwsAuthSetup`.
 */
export async function gwsAuthLogin(): Promise<number> {
	const bin = requireGws();
	const proc = Bun.spawn([bin, "auth", "login"], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
	const code = await proc.exited;
	return code ?? 0;
}
