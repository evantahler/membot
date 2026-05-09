import type { Command } from "commander";
import { z } from "zod";
import { loadConfig, saveConfig } from "../config/loader.ts";
import { type MembotConfig, MembotConfigSchema } from "../config/schemas.ts";
import { ENV } from "../constants.ts";
import { HelpfulError, isHelpfulError, mapKindToExit } from "../errors.ts";
import { renderCliError } from "../mount/commander.ts";
import { colors, renderTable } from "../output/formatter.ts";
import { logger } from "../output/logger.ts";
import { detectMode, isJson, setMode } from "../output/tty.ts";

/**
 * The set of value shapes any config leaf can take. Mirrors the zod leaf
 * types used in `MembotConfigSchema` — extend this when the schema gains a
 * new primitive (e.g. arrays, enums).
 */
export type ConfigFieldKind = "string" | "number" | "boolean" | "null" | "unknown";

/**
 * Single source of truth for "what does this config key look like?":
 * - `path` — dot-notation address (e.g. `llm.anthropic_api_key`)
 * - `kind` — runtime value shape, derived from the zod schema
 * - `nullable` — whether `null` is a legal value
 * - `is_secret` — declared at the schema level via `.meta({ secret: true })`;
 *   drives masking on every read path
 */
export interface ConfigField {
	path: string;
	kind: ConfigFieldKind;
	nullable: boolean;
	is_secret: boolean;
}

interface ConfigGetOptions {
	showSecrets?: boolean;
}

/**
 * Register the `membot config` parent command and its subcommands
 * (`get`, `set`, `unset`, `list`, `path`). All subcommands read from and
 * write to `~/.membot/config.json` via the existing `loadConfig` /
 * `saveConfig` helpers, so dot-paths, defaults, and env-var precedence
 * stay consistent with the rest of membot.
 */
export function registerConfigCommand(program: Command): void {
	const config = program.command("config").description("Get and set membot config values in ~/.membot/config.json");

	config
		.command("get")
		.argument("[key]", "dot-notation key (e.g. llm.anthropic_api_key); omit to print all values")
		.option("--show-secrets", "print secret values (e.g. API keys) unmasked")
		.description("Print a config value at the given dot-notation key, or all values if no key is given")
		.action(async (key: string | undefined, opts: ConfigGetOptions) => {
			await runSubcommand(program, async () => {
				if (key === undefined) {
					await runList(opts);
				} else {
					await runGet(key, opts);
				}
			});
		});

	config
		.command("set")
		.argument("<key>", "dot-notation key (e.g. llm.anthropic_api_key)")
		.argument("<value>", 'JSON literal (42, true, null, "text") or raw string')
		.description("Set a config value at the given dot-notation key. Persists to ~/.membot/config.json")
		.action(async (key: string, value: string) => {
			await runSubcommand(program, async () => {
				await runSet(key, value);
			});
		});

	config
		.command("unset")
		.argument("<key>", "dot-notation key (e.g. chunker.target_chars)")
		.description("Reset a config value to its schema default")
		.action(async (key: string) => {
			await runSubcommand(program, async () => {
				await runUnset(key);
			});
		});

	config
		.command("list")
		.option("--show-secrets", "print secret values (e.g. API keys) unmasked")
		.description("Print every config value (table on a TTY, JSON otherwise). Secrets masked by default")
		.action(async (opts: ConfigGetOptions) => {
			await runSubcommand(program, async () => {
				await runList(opts);
			});
		});

	config
		.command("path")
		.description("Print the absolute path to the config file")
		.action(async () => {
			await runSubcommand(program, async () => {
				await runPath();
			});
		});
}

/**
 * Apply global flags to the output mode (so `--json` / `--no-color` /
 * `CI=true` are honored) and turn any thrown error into a uniform
 * `renderCliError` + appropriate exit code.
 */
async function runSubcommand(program: Command, fn: () => Promise<void>): Promise<void> {
	const globalOpts = program.optsWithGlobals<{
		json?: boolean;
		verbose?: boolean;
		color?: boolean;
	}>();
	setMode(
		detectMode({
			json: globalOpts.json,
			verbose: globalOpts.verbose,
			noColor: globalOpts.color === false,
		}),
	);
	try {
		await fn();
	} catch (err) {
		renderCliError(err);
		process.exit(isHelpfulError(err) ? mapKindToExit(err.kind) : 1);
	}
}

/** Print a single config value at `key`, masked unless `--show-secrets`. */
export async function runGet(key: string, opts: ConfigGetOptions): Promise<void> {
	resolveSchemaPath(MembotConfigSchema, key);
	const { config } = await loadConfig();
	const raw = getValueAt(config, key);
	const value = opts.showSecrets ? raw : maskIfSecret(key, raw);
	if (isJson()) {
		process.stdout.write(`${JSON.stringify(value)}\n`);
		return;
	}
	process.stdout.write(`${formatScalar(value)}\n`);
}

/**
 * Coerce + validate + persist `value` at `key`. Coercion rule: try
 * `JSON.parse(value)` first (so `42` / `true` / `null` work); fall back to
 * the raw string. Validation runs the full `MembotConfigSchema` parse, so
 * type errors surface a precise hint.
 */
export async function runSet(key: string, rawValue: string): Promise<void> {
	resolveSchemaPath(MembotConfigSchema, key);
	const coerced = coerceValue(rawValue);

	const { config, configPath } = await loadConfig();
	const draft = structuredClone(config);
	setValueAt(draft, key, coerced);

	const validated = validateOrThrow(draft, key);
	await saveConfig(configPath, validated);

	if (isJson()) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, key, value: maskIfSecret(key, getValueAt(validated, key)) })}\n`,
		);
	} else {
		const display = formatScalar(maskIfSecret(key, getValueAt(validated, key)));
		logger.info(`set ${key} = ${display}`);
	}

	// If a user just persisted the API key while ANTHROPIC_API_KEY is also set
	// in the environment, the env wins on read — surface that so they don't
	// wonder why their new value isn't taking effect.
	if (key === "llm.anthropic_api_key" && process.env[ENV.ANTHROPIC_API_KEY]?.trim()) {
		logger.warn(
			`note: ANTHROPIC_API_KEY is set in your environment and overrides the file at read time. Unset it (\`unset ANTHROPIC_API_KEY\`) to use the value you just saved.`,
		);
	}
}

/** Reset `key` to whatever `MembotConfigSchema` produces from `{}`. */
export async function runUnset(key: string): Promise<void> {
	resolveSchemaPath(MembotConfigSchema, key);
	const defaults = MembotConfigSchema.parse({});
	const defaultValue = getValueAt(defaults, key);

	const { config, configPath } = await loadConfig();
	const draft = structuredClone(config);
	setValueAt(draft, key, defaultValue);

	const validated = validateOrThrow(draft, key);
	await saveConfig(configPath, validated);

	if (isJson()) {
		process.stdout.write(`${JSON.stringify({ ok: true, key, value: maskIfSecret(key, defaultValue) })}\n`);
	} else {
		logger.info(`unset ${key} → ${formatScalar(maskIfSecret(key, defaultValue))}`);
	}
}

/** Print every key/value pair. JSON mode → nested config object; TTY → table. */
async function runList(opts: ConfigGetOptions): Promise<void> {
	const { config } = await loadConfig();
	if (isJson()) {
		const masked = opts.showSecrets ? config : maskAllSecrets(config);
		process.stdout.write(`${JSON.stringify(masked, null, 2)}\n`);
		return;
	}
	const paths = enumerateSchemaPaths(MembotConfigSchema);
	const rows = paths.map((p) => {
		const raw = getValueAt(config, p);
		const value = opts.showSecrets ? raw : maskIfSecret(p, raw);
		return [colors.cyan(p), formatScalar(value)];
	});
	process.stdout.write(`${renderTable(["key", "value"], rows)}\n`);
}

/** Print the absolute path to the config file. */
async function runPath(): Promise<void> {
	const { configPath } = await loadConfig();
	if (isJson()) {
		process.stdout.write(`${JSON.stringify({ path: configPath })}\n`);
		return;
	}
	process.stdout.write(`${configPath}\n`);
}

/**
 * Walk a dotted path through `MembotConfigSchema` and return the leaf zod
 * type. Descends into `ZodObject.shape` and transparently unwraps
 * `ZodDefault` / `ZodOptional` / `ZodNullable`. Throws `HelpfulError` if any
 * segment doesn't exist, with a "did you mean" suggestion derived from the
 * full set of valid paths.
 */
export function resolveSchemaPath(schema: z.ZodTypeAny, dottedPath: string): z.ZodTypeAny {
	const segments = dottedPath.split(".").filter((s) => s.length > 0);
	if (segments.length === 0) {
		throw new HelpfulError({
			kind: "input_error",
			message: "config key is required",
			hint: "Pass a dot-notation key, e.g. `membot config get llm.anthropic_api_key`. Run `membot config list` for the full set.",
		});
	}

	let current = unwrapSchema(schema);
	const traversed: string[] = [];
	for (const segment of segments) {
		if (!(current instanceof z.ZodObject)) {
			throw unknownKeyError(dottedPath, traversed.join("."));
		}
		const shape = current.shape as Record<string, z.ZodTypeAny>;
		const next = shape[segment];
		if (!next) {
			throw unknownKeyError(dottedPath, [...traversed, segment].join("."));
		}
		traversed.push(segment);
		current = unwrapSchema(next);
	}
	return current;
}

/**
 * Build the `HelpfulError` for an unknown key. Includes a "did you mean"
 * suggestion when there's an obvious near-match (Levenshtein distance ≤ 2).
 */
function unknownKeyError(badPath: string, _matchedPrefix: string): HelpfulError {
	const valid = enumerateSchemaPaths(MembotConfigSchema);
	const suggestion = nearestPath(badPath, valid);
	const baseHint = "Run `membot config list` to see all valid keys.";
	const hint = suggestion ? `Did you mean \`${suggestion}\`? ${baseHint}` : baseHint;
	return new HelpfulError({
		kind: "input_error",
		message: `unknown config key: ${badPath}`,
		hint,
	});
}

/** Return the closest known path within Levenshtein distance 2, or null. */
function nearestPath(target: string, candidates: readonly string[]): string | null {
	let best: { path: string; distance: number } | null = null;
	for (const c of candidates) {
		const d = levenshtein(target, c);
		if (d <= 2 && (!best || d < best.distance)) best = { path: c, distance: d };
	}
	return best?.path ?? null;
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const prev = new Array<number>(b.length + 1);
	const curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
		}
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
	}
	return prev[b.length] ?? 0;
}

/**
 * Strip every layer of `ZodDefault` / `ZodOptional` / `ZodNullable`. Zod 4
 * types `.unwrap()` as the lower-level `$ZodType` rather than `ZodType`, so
 * we cast back through `unknown` — the runtime instance is a real `ZodType`.
 */
function unwrapSchema(t: z.ZodTypeAny): z.ZodTypeAny {
	let cur = t;
	while (cur instanceof z.ZodDefault || cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) {
		cur = cur.unwrap() as unknown as z.ZodTypeAny;
	}
	return cur;
}

/**
 * Walk every wrapper layer of a zod leaf (default / optional / nullable)
 * and return: the innermost type, whether `null` is legal, and the merged
 * `.meta()` from every layer (outer layers win on conflict).
 *
 * Zod 4's `.meta()` is bound to the specific layer where it was declared —
 * `.meta({secret:true}).default("")` and `.default("").meta({secret:true})`
 * land it on different wrappers — so we have to scan all of them.
 */
function walkLeaf(t: z.ZodTypeAny): {
	leaf: z.ZodTypeAny;
	nullable: boolean;
	meta: Record<string, unknown>;
} {
	let cur = t;
	let nullable = false;
	const layers: z.ZodTypeAny[] = [cur];
	while (cur instanceof z.ZodDefault || cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) {
		if (cur instanceof z.ZodNullable) nullable = true;
		cur = cur.unwrap() as unknown as z.ZodTypeAny;
		layers.push(cur);
	}
	let meta: Record<string, unknown> = {};
	// inner-to-outer merge so outer layers (declared closer to the user) win
	for (const layer of layers) {
		const layerMeta = (layer as { meta?: () => Record<string, unknown> | undefined }).meta?.();
		if (layerMeta) meta = { ...meta, ...layerMeta };
	}
	return { leaf: cur, nullable, meta };
}

/** Map a zod leaf type to its `ConfigFieldKind` discriminator. */
function inferKind(leaf: z.ZodTypeAny): ConfigFieldKind {
	if (leaf instanceof z.ZodString) return "string";
	if (leaf instanceof z.ZodNumber) return "number";
	if (leaf instanceof z.ZodBoolean) return "boolean";
	if (leaf instanceof z.ZodNull) return "null";
	return "unknown";
}

/**
 * Recursively enumerate every leaf in a zod schema as a `ConfigField`. This
 * is the single source of truth for what's gettable / settable / maskable —
 * adding a new field to `MembotConfigSchema` (and tagging it with
 * `.meta({secret:true})` if appropriate) is enough to make every path here
 * pick it up automatically.
 */
export function enumerateSchemaFields(schema: z.ZodTypeAny, prefix = ""): ConfigField[] {
	const root = unwrapSchema(schema);
	if (!(root instanceof z.ZodObject)) {
		if (!prefix) return [];
		const { leaf, nullable, meta } = walkLeaf(schema);
		return [{ path: prefix, kind: inferKind(leaf), nullable, is_secret: meta.secret === true }];
	}
	const out: ConfigField[] = [];
	const shape = root.shape as Record<string, z.ZodTypeAny>;
	for (const key of Object.keys(shape)) {
		const child = shape[key] as z.ZodTypeAny;
		const childUnwrapped = unwrapSchema(child);
		const path = prefix ? `${prefix}.${key}` : key;
		if (childUnwrapped instanceof z.ZodObject) {
			out.push(...enumerateSchemaFields(childUnwrapped, path));
		} else {
			const { leaf, nullable, meta } = walkLeaf(child);
			out.push({ path, kind: inferKind(leaf), nullable, is_secret: meta.secret === true });
		}
	}
	return out;
}

/** Backward-compatible wrapper: just the dotted paths, no metadata. */
export function enumerateSchemaPaths(schema: z.ZodTypeAny, prefix = ""): string[] {
	return enumerateSchemaFields(schema, prefix).map((f) => f.path);
}

/**
 * Field index built once from `MembotConfigSchema` at module load. Every
 * read/write path consults this instead of duplicating schema introspection.
 */
const FIELD_INDEX: ReadonlyMap<string, ConfigField> = new Map(
	enumerateSchemaFields(MembotConfigSchema).map((f) => [f.path, f]),
);

/** Look up the `ConfigField` for a known dotted path, or `undefined`. */
export function getField(path: string): ConfigField | undefined {
	return FIELD_INDEX.get(path);
}

/** Read the value at a dotted path from a plain object. */
function getValueAt(obj: unknown, dottedPath: string): unknown {
	let cur: unknown = obj;
	for (const segment of dottedPath.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[segment];
	}
	return cur;
}

/**
 * Set the value at a dotted path on a plain object, creating intermediate
 * objects as needed. Mutates `obj` in place.
 */
function setValueAt(obj: Record<string, unknown>, dottedPath: string, value: unknown): void {
	const segments = dottedPath.split(".");
	let cur: Record<string, unknown> = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i] as string;
		const next = cur[seg];
		if (next === null || typeof next !== "object") {
			cur[seg] = {};
		}
		cur = cur[seg] as Record<string, unknown>;
	}
	cur[segments[segments.length - 1] as string] = value;
}

/**
 * Try `JSON.parse` (so `42`, `true`, `null`, `"foo"` all coerce correctly);
 * fall back to the raw string when the value isn't valid JSON.
 */
function coerceValue(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/**
 * Reparse the entire draft against `MembotConfigSchema`. On failure, throw
 * a `HelpfulError` whose hint names the offending dot-path and shows the
 * zod error message — far more useful than zod's raw issue array.
 */
function validateOrThrow(draft: unknown, key: string): MembotConfig {
	const result = MembotConfigSchema.safeParse(draft);
	if (result.success) return result.data;
	const issue = result.error.issues.find((i) => i.path.join(".") === key) ?? result.error.issues[0];
	const issuePath = issue?.path.join(".") ?? key;
	const issueMessage = issue?.message ?? result.error.message;
	throw new HelpfulError({
		kind: "input_error",
		message: `invalid value for ${issuePath}: ${issueMessage}`,
		hint: `Run \`membot config get ${issuePath}\` to see the current value, or \`membot config unset ${issuePath}\` to reset to default.`,
		details: result.error.issues,
		cause: result.error,
	});
}

/**
 * Mask a value for display when its `ConfigField.is_secret` is true.
 * Non-secret paths and unknown paths pass through unchanged.
 */
export function maskIfSecret(path: string, value: unknown): unknown {
	if (!getField(path)?.is_secret) return value;
	if (typeof value !== "string" || value.length === 0) return value;
	if (value.length <= 11) return "****";
	return `${value.slice(0, 7)}...${value.slice(-4)}`;
}

/** Walk a config object and mask every secret field in place. */
function maskAllSecrets(config: MembotConfig): MembotConfig {
	const clone = structuredClone(config) as Record<string, unknown>;
	for (const field of FIELD_INDEX.values()) {
		if (!field.is_secret) continue;
		const current = getValueAt(clone, field.path);
		setValueAt(clone, field.path, maskIfSecret(field.path, current));
	}
	return clone as MembotConfig;
}

/** Render a scalar (or null/undefined/object) for human-readable output. */
function formatScalar(value: unknown): string {
	if (value === null) return colors.dim("null");
	if (value === undefined) return colors.dim("(unset)");
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}
