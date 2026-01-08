.PHONY: help build install dev clean

# Default vault path - override with: make install VAULT_PATH=/path/to/vault
VAULT_PATH ?= $(HOME)/Documents/Obsidian/MyVault
PLUGIN_DIR = $(VAULT_PATH)/.obsidian/plugins/obsidian-local-rest-api

help:
	@echo "Local REST API Development Commands"
	@echo ""
	@echo "  make build        - Build plugin (creates main.js)"
	@echo "  make install      - Install plugin to Obsidian vault"
	@echo "  make dev          - Build in watch mode"
	@echo "  make clean        - Remove build artifacts"
	@echo ""
	@echo "Installation:"
	@echo "  1. Set VAULT_PATH: export VAULT_PATH=/path/to/your/vault"
	@echo "  2. Run: make build install"
	@echo "  3. In Obsidian: Settings → Community Plugins → Enable 'Local REST API'"
	@echo "  4. Get API key from plugin settings"
	@echo ""
	@echo "Testing:"
	@echo "  make test         - Run tests"
	@echo ""
	@echo "Current vault path: $(VAULT_PATH)"

build:
	@echo "Building plugin..."
	npm run build
	@echo "✓ Build complete: main.js created"

install: build
	@echo "Installing to Obsidian vault..."
	@if [ ! -d "$(VAULT_PATH)" ]; then \
		echo "Error: Vault not found at $(VAULT_PATH)"; \
		echo "Set VAULT_PATH: export VAULT_PATH=/path/to/your/vault"; \
		exit 1; \
	fi
	@mkdir -p "$(PLUGIN_DIR)"
	@cp main.js "$(PLUGIN_DIR)/"
	@cp manifest.json "$(PLUGIN_DIR)/"
	@cp styles.css "$(PLUGIN_DIR)/"
	@echo "✓ Installed to $(PLUGIN_DIR)"
	@echo ""
	@echo "Next steps:"
	@echo "  1. Restart Obsidian (or reload plugins)"
	@echo "  2. Settings → Community Plugins"
	@echo "  3. Enable 'Local REST API'"
	@echo "  4. Find API key in plugin settings"

dev:
	@echo "Starting dev mode (watch)..."
	npm run dev

test:
	npm test

clean:
	@echo "Cleaning build artifacts..."
	@rm -f main.js
	@echo "✓ Clean complete"
