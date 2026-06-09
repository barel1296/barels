.PHONY: infra-up infra-down migrate seed dev-api dev-web worker check-infra qa

infra-up:
	docker compose -f infra/docker-compose.dev.yml up -d

infra-down:
	docker compose -f infra/docker-compose.dev.yml down

check-infra:
	bash scripts/check-infra.sh

migrate:
	pnpm db:migrate
	cd workers/py && uv run python -m gros_workers.chmigrate

seed:
	pnpm db:seed
	cd workers/py && uv run python -m gros_workers.seed.generate

dev-api:
	pnpm dev:api

dev-web:
	pnpm dev:web

worker:
	cd workers/py && uv run python -m gros_workers.main

qa:
	pnpm lint && pnpm typecheck && pnpm test && pnpm build
	cd workers/py && uv run ruff check . && uv run mypy gros_workers && uv run pytest -q
