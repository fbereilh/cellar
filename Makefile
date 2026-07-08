# Cellar — convenience commands for installing, updating, and running.
#
# Common flow:
#   make setup     first-time install: build + link `cellar` onto your PATH
#   make update    pull the latest, reinstall deps, and rebuild
#   make run       run cellar in the current directory
#
# The npm link from `make setup` persists across rebuilds, so `make update`
# never needs to re-link.

.DEFAULT_GOAL := help

.PHONY: help setup install build update run dev

help: ## List available targets
	@echo "Cellar — make targets:"
	@echo "  make setup    First-time install: npm install, build, and link 'cellar' onto PATH"
	@echo "  make update   Pull latest, reinstall deps, and rebuild (updates the linked 'cellar')"
	@echo "  make build    Install deps and build the production server"
	@echo "  make run      Run cellar in the current directory"
	@echo "  make dev      Run cellar in dev mode (Vite dev server)"
	@echo "  make help     Show this help (default)"

setup: build ## First-time setup: build, then link 'cellar' onto PATH
	@echo "==> Ensuring launcher is executable (chmod +x bin/cellar.js)"
	chmod +x bin/cellar.js
	@echo "==> Linking 'cellar' onto your PATH (npm link)"
	npm link
	@echo "==> Done. Run 'cellar' in any project directory."

# Alias for setup.
install: setup ## Alias for 'setup'

build: ## Install dependencies and build the production server
	@echo "==> Installing dependencies (npm install)"
	npm install
	@echo "==> Building production server (npm run build)"
	npm run build

update: ## Pull latest, reinstall deps, and rebuild
	@echo "==> Pulling latest (git pull)"
	git pull
	@echo "==> Installing dependencies (npm install)"
	npm install
	@echo "==> Building production server (npm run build)"
	npm run build
	@echo "==> Updated. The linked 'cellar' command now serves the new version."

run: ## Run cellar in the current directory
	@echo "==> Starting cellar in $(CURDIR)"
	node bin/cellar.js

dev: ## Run cellar in dev mode (Vite dev server)
	@echo "==> Starting cellar in dev mode"
	node bin/cellar.js --dev
