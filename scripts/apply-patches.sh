#!/usr/bin/env bash
set -euo pipefail

# Apply node_modules patches imperatively. We don't use package.json's
# `patchedDependencies` field because that field, when present in a published
# package, breaks `bun install` from a tarball.
#
# Each patch is gated by a marker file inside its target so reruns are no-ops.

apply_patch() {
	local patch="$1" target="$2" marker_name="$3"
	local marker="$target/$marker_name"

	if [ ! -d "$target" ]; then
		echo "error: $target not found — run \`bun install\` first" >&2
		exit 1
	fi
	if [ ! -f "$patch" ]; then
		echo "error: $patch not found" >&2
		exit 1
	fi
	if [ -f "$marker" ]; then
		echo "patch $patch already applied — skipping"
		return 0
	fi

	echo "Applying $patch to $target..."
	git apply --directory="$target" "$patch"
	touch "$marker"
}

# @huggingface/transformers — replace static `import 'onnxruntime-node'` with a
# stub so `bun build --compile` produces a binary using the WASM backend
# (onnxruntime-web) instead of onnxruntime-node, whose native bindings can't be
# bundled into a single-binary distribution.
apply_patch \
	"patches/@huggingface%2Ftransformers@4.2.0.patch" \
	"node_modules/@huggingface/transformers" \
	".membot-transformers-patch-applied"

# @evantahler/mcpx — stub `src/search/onnx-wasm-paths.ts` whose static
# `with { type: "file" }` imports use a relative path that only resolves in
# mcpx's own repo layout. When mcpx is consumed as an npm dep those paths are
# unreachable and `bun build --compile` fails at build time. membot never
# invokes mcpx's semantic search, so the stubbed exports are safe.
apply_patch \
	"patches/@evantahler%2Fmcpx@0.21.4.patch" \
	"node_modules/@evantahler/mcpx" \
	".membot-mcpx-patch-applied"
