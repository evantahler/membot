import { type Command, Option } from "commander";
import { z } from "zod";
import { HelpfulError } from "../errors.ts";

/**
 * Walk a zod object schema and register its fields onto a commander command.
 * Each field becomes either a positional `<arg>`/`[arg]` or a `--flag`,
 * with descriptions sourced from `.describe()` so the same docstring shows
 * up in `--help` and in the MCP tool's parameter description.
 */
export function applySchemaToCommand<S extends z.ZodObject>(
	cmd: Command,
	schema: S,
	options: {
		positional?: readonly string[];
		aliases?: Readonly<Record<string, string>>;
	} = {},
): void {
	const positional = new Set(options.positional ?? []);
	const aliases = options.aliases ?? {};

	const shape = schema.shape;
	const positionalOrder = options.positional ?? [];

	for (const fieldName of positionalOrder) {
		const fieldSchema = shape[fieldName];
		if (!fieldSchema) continue;
		const required = !isOptional(fieldSchema);
		const label = required ? `<${fieldName}>` : `[${fieldName}]`;
		cmd.argument(label, describeOf(fieldSchema));
	}

	for (const [fieldName, fieldSchemaUnknown] of Object.entries(shape)) {
		if (positional.has(fieldName)) continue;
		const fieldSchema = fieldSchemaUnknown as z.ZodTypeAny;
		const flag = toKebab(fieldName);
		const desc = describeOf(fieldSchema);
		const alias = aliases[fieldName];
		const opt = buildOption(fieldName, flag, desc, fieldSchema, alias);
		cmd.addOption(opt);
	}
}

/**
 * Translate a single zod field into a commander Option. Booleans become
 * boolean flags (`--flag` / `--no-flag`); enums become `.choices(...)`;
 * arrays of strings become repeatable flags; everything else becomes a
 * value-taking flag whose argument is parsed as the field's primitive type.
 */
function buildOption(
	_fieldName: string,
	flag: string,
	desc: string,
	schema: z.ZodTypeAny,
	alias: string | undefined,
): Option {
	const inner = unwrap(schema);

	if (inner instanceof z.ZodBoolean) {
		const longFlag = `--${flag}`;
		const opt = new Option(`${alias ? `${alias}, ` : ""}${longFlag}`, desc);
		const def = defaultOf(schema);
		if (def !== undefined) opt.default(def as boolean);
		return opt;
	}

	if (inner instanceof z.ZodEnum) {
		const opt = new Option(`${alias ? `${alias}, ` : ""}--${flag} <value>`, desc);
		const enumValues = inner.options as readonly string[];
		opt.choices(enumValues as string[]);
		const def = defaultOf(schema);
		if (def !== undefined) opt.default(def);
		return opt;
	}

	if (inner instanceof z.ZodArray) {
		const opt = new Option(`${alias ? `${alias}, ` : ""}--${flag} <value>`, `${desc} (repeatable)`);
		opt.argParser((val: string, prev: string[] | undefined) => {
			const next = prev ?? [];
			next.push(val);
			return next;
		});
		const def = defaultOf(schema);
		if (def !== undefined) opt.default(def);
		return opt;
	}

	if (inner instanceof z.ZodNumber) {
		const opt = new Option(`${alias ? `${alias}, ` : ""}--${flag} <value>`, desc);
		opt.argParser((v: string) => {
			const n = Number(v);
			if (Number.isNaN(n)) {
				throw new HelpfulError({
					kind: "input_error",
					message: `invalid number for --${flag}: ${JSON.stringify(v)}`,
					hint: `Pass a numeric value, e.g. \`--${flag} 10\`. Run \`membot <command> --help\` to see expected types.`,
				});
			}
			return n;
		});
		const def = defaultOf(schema);
		if (def !== undefined) opt.default(def);
		return opt;
	}

	const opt = new Option(`${alias ? `${alias}, ` : ""}--${flag} <value>`, desc);
	const def = defaultOf(schema);
	if (def !== undefined) opt.default(def);
	return opt;
}

/** Pull through `.optional()` and `.default()` wrappers to find the underlying schema. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
	let cur: z.ZodTypeAny = schema;
	while (true) {
		if (cur instanceof z.ZodOptional) cur = cur.unwrap() as z.ZodTypeAny;
		else if (cur instanceof z.ZodDefault) cur = cur._def.innerType as z.ZodTypeAny;
		else if (cur instanceof z.ZodNullable) cur = cur.unwrap() as z.ZodTypeAny;
		else break;
	}
	return cur;
}

/** True when the field is optional or defaulted (no value required from the user). */
function isOptional(schema: z.ZodTypeAny): boolean {
	if (schema instanceof z.ZodOptional) return true;
	if (schema instanceof z.ZodDefault) return true;
	if (schema instanceof z.ZodNullable) return true;
	return false;
}

/** Read the description set via `.describe()`, falling back to an empty string. */
function describeOf(schema: z.ZodTypeAny): string {
	const desc = (schema._def as { description?: string }).description;
	return desc ?? "";
}

/**
 * Read the static `.default()` value off a zod schema, walking through
 * `.optional()` to find the inner default. Returns undefined when no default
 * is set so commander treats the option as truly optional.
 */
function defaultOf(schema: z.ZodTypeAny): unknown {
	let cur: z.ZodTypeAny = schema;
	while (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) {
		cur = cur.unwrap() as z.ZodTypeAny;
	}
	if (cur instanceof z.ZodDefault) {
		const def = cur._def.defaultValue;
		return typeof def === "function" ? def() : def;
	}
	return undefined;
}

/** snake_case → kebab-case for CLI flag names. */
export function toKebab(name: string): string {
	return name.replaceAll("_", "-");
}
