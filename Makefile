.PHONY: lint typecheck format format-check check

lint:
	bun run lint

typecheck:
	bun run typecheck

format:
	bun run format

format-check:
	bun run format:check

check: lint typecheck format-check
