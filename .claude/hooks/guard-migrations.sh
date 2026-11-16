#!/bin/sh
f=$(jq -r '.tool_input.file_path // empty')
case "$f" in
  */src/db/migrations/*.sql)
    rel=${f#"$(git rev-parse --show-toplevel)/"}
    if git cat-file -e "origin/main:$rel" 2>/dev/null; then
      echo "Migrations on main are forward-only. Add a new numbered migration instead of editing $rel." >&2
      exit 2
    fi ;;
esac
exit 0
