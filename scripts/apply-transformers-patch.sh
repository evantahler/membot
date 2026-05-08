#!/usr/bin/env bash
set -euo pipefail

# Apply the @huggingface/transformers patch to node_modules so that
# `bun build --compile` produces a binary using the WASM backend
# (onnxruntime-web) instead of onnxruntime-node, whose native bindings
# can't be bundled into a single-binary distribution.
#
# We apply the patch imperatively (rather than via package.json
# `patchedDependencies`) because that field, when present in a
# published package, breaks `bun install` from a tarball.

PATCH="patches/@huggingface%2Ftransformers@4.2.0.patch"
TARGET="node_modules/@huggingface/transformers"
MARKER="$TARGET/.membot-transformers-patch-applied"

if [ ! -d "$TARGET" ]; then
	echo "error: $TARGET not found — run \`bun install\` first" >&2
	exit 1
fi

if [ ! -f "$PATCH" ]; then
	echo "error: $PATCH not found" >&2
	exit 1
fi

if [ -f "$MARKER" ]; then
	echo "transformers patch already applied — skipping"
	exit 0
fi

echo "Applying transformers patch ($PATCH) to $TARGET..."
git apply --directory="$TARGET" "$PATCH"
touch "$MARKER"
echo "Patch applied."
