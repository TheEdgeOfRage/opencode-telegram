.PHONY: lint typecheck check

lint:
	bun run lint

typecheck:
	bun run typecheck

check: lint typecheck
