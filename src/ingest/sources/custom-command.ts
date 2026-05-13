import type { MembotConfig } from "../../config/schemas.ts";
import { compileRouterPattern, getCustomRouters, type Router } from "../../config/router-validation.ts";
import { asHelpful, HelpfulError } from "../../errors.ts";
import { sha256Hex } from "../local-reader.ts";
import { applyPostProcessor, substituteVars } from "./post-processors.ts";
import { defaultUrlHint, registerSource } from "./registry.ts";
import { type BatchFetcher, type DownloadedRemote, defineSourcePlugin, type Entry } from "./types.ts";

interface CustomArgs extends Record<string, unknown> {
	router: string;
	vars: Record<string, string>;
}

/**
 * User-defined URL routers. Dispatch matches a URL against
 * `config.downloaders.custom_routers[*].url_pattern` (registration order,
 * first hit wins), then invokes the configured shell command with
 * `{var}` placeholders substituted from named capture groups. The
 * command's stdout flows through an optional post-processor before
 * landing in the converter pipeline.
 *
 * This plugin is registered LAST so built-in plugins (github, linear)
 * always win on overlapping patterns. Refresh persists the router name
 * in `downloader_args.router`; a row whose router has been removed
 * from config surfaces a HelpfulError naming the missing router rather
 * than silently picking a different match.
 */
const customCommandPlugin = defineSourcePlugin<Record<string, unknown>, CustomArgs>({
	name: "custom-command",
	description:
		"User-defined URL routers. Each entry matches a URL pattern and runs an external shell command (mcpx, gws, gcloud, etc.) to fetch the content. Manage with `membot router add/list/remove`.",
	examples: ["(any URL matching a router registered via `membot router add`)"],
	notes:
		"Custom routers run arbitrary commands from your config file — that's the point. Argv arrays mean no shell interpolation, but the user opts into running whatever they configure on every ingest and refresh.",
	match: {
		kind: "dynamic",
		matches: (url, config) => findMatchingRouter(url, config) !== null,
	},
	async enumerate(source, ctx) {
		const url = new URL(source);
		const router = findMatchingRouter(url, ctx.config);
		if (!router) {
			throw new HelpfulError({
				kind: "input_error",
				message: `no custom router matches: ${source}`,
				hint: "Run `membot router list` to see registered routers, or `membot router add` to register one.",
			});
		}
		const vars = extractVars(router, url);
		return [
			{
				source: url.toString(),
				logicalPathHint: defaultUrlHint(url),
				cursor: { router: router.name, vars },
			},
		];
	},
	rehydrateEntry(source, args): Entry<CustomArgs> {
		const url = new URL(source);
		return {
			source: url.toString(),
			logicalPathHint: defaultUrlHint(url),
			cursor: args,
		};
	},
	async openBatchFetcher(): Promise<BatchFetcher<CustomArgs>> {
		return {
			async fetch(entry, ctx): Promise<DownloadedRemote> {
				const router = findRouterByName(entry.cursor.router, ctx.config);
				if (!router) {
					throw new HelpfulError({
						kind: "input_error",
						message: `custom router "${entry.cursor.router}" is no longer registered`,
						hint: `Re-add it with \`membot router add --name ${entry.cursor.router} ...\`, or remove this row with \`membot remove <path>\`.`,
					});
				}
				ctx.onProgress?.(`running ${router.command}`);
				const stdout = await runRouterCommand(router, entry.cursor.vars, entry.source);
				ctx.onProgress?.("post-processing");
				const finalBytes = await applyPostProcessor(router.post_process, stdout, entry.cursor.vars, entry.source);
				return {
					bytes: finalBytes,
					sha256: sha256Hex(finalBytes),
					mimeType: router.mime_type,
					downloader: "custom-command",
					downloaderArgs: { router: router.name, vars: entry.cursor.vars },
					sourceUrl: entry.source,
				};
			},
			async close() {},
		};
	},
});

/**
 * Walk the user's router list in registration order; return the first
 * router whose compiled url_pattern matches the parsed URL. Returns
 * null when no router claims the URL — the dispatcher then falls
 * through to the existing "no plugin matches" HelpfulError.
 */
function findMatchingRouter(url: URL, config: MembotConfig): Router | null {
	const routers = getCustomRouters(config);
	const full = url.toString();
	for (const router of routers) {
		const re = compileRouterPattern(router);
		if (re.test(full)) return router;
	}
	return null;
}

/**
 * Lookup by router name. Refresh uses this to recover the live router
 * definition for a persisted `downloader_args.router` — a router that
 * has been renamed or removed surfaces as a clear HelpfulError instead
 * of silently re-routing through whatever router now matches the URL.
 */
function findRouterByName(name: string, config: MembotConfig): Router | null {
	for (const router of getCustomRouters(config)) {
		if (router.name === name) return router;
	}
	return null;
}

/**
 * Run the router's named regex against the URL and pull every named
 * capture group into a `Record<string, string>`. The orchestrator
 * persists this map under `downloader_args.vars`, which means a
 * router whose url_pattern changes after ingest can still refresh —
 * the new pattern isn't re-run on persisted rows, so the captured
 * vars stay stable.
 */
function extractVars(router: Router, url: URL): Record<string, string> {
	const re = compileRouterPattern(router);
	const match = re.exec(url.toString());
	if (!match || !match.groups) {
		throw new HelpfulError({
			kind: "input_error",
			message: `router "${router.name}" pattern matched ${url.toString()} but produced no named capture groups`,
			hint: `Add (?<name>...) groups to the url_pattern via \`membot router add --name ${router.name} --url-pattern '<pattern>'\`. The matched text is then available as {name} in args/stdin.`,
		});
	}
	const vars: Record<string, string> = {};
	for (const [key, value] of Object.entries(match.groups)) {
		if (typeof value === "string") vars[key] = value;
	}
	return vars;
}

/**
 * Spawn the router's primary command, capture stdout, and surface
 * timeouts / non-zero exits as HelpfulError with the stderr tail.
 * Uses an argv array (no shell), so router-config strings can't be
 * splattered together into a shell-injection vector.
 */
async function runRouterCommand(
	router: Router,
	vars: Record<string, string>,
	url: string,
): Promise<Uint8Array> {
	const args = router.args.map((arg) => substituteVars(arg, vars, url));
	const stdinPayload = router.stdin ? substituteVars(router.stdin, vars, url) : null;

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn({
			cmd: [router.command, ...args],
			stdin: stdinPayload ? new TextEncoder().encode(stdinPayload) : undefined,
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		throw asHelpful(
			err,
			`while spawning router "${router.name}" command "${router.command}"`,
			`Verify the command is on PATH: \`which ${router.command}\`. Update the router with \`membot router add --name ${router.name} --command <path>\`.`,
			"input_error",
		);
	}

	const killTimer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// best-effort
		}
	}, router.timeout_ms);

	let exitCode: number;
	let stdout: ArrayBuffer;
	let stderr: ArrayBuffer;
	try {
		[exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout as ReadableStream).arrayBuffer(),
			new Response(proc.stderr as ReadableStream).arrayBuffer(),
		]);
	} finally {
		clearTimeout(killTimer);
	}

	if (exitCode !== 0) {
		const stderrText = new TextDecoder().decode(stderr).trim().slice(-500);
		throw new HelpfulError({
			kind: "network_error",
			message: `router "${router.name}" command "${router.command}" exited ${exitCode}${stderrText ? `: ${stderrText}` : ""}`,
			hint: `Run \`${router.command} ${args.join(" ")}\` manually to reproduce. If the upstream service rotated credentials, update them outside membot; if the command interface changed, re-register the router with \`membot router add --name ${router.name} ...\`.`,
		});
	}

	return new Uint8Array(stdout);
}

registerSource(customCommandPlugin);

export { customCommandPlugin };
