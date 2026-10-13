.DEFAULT_GOAL := help
.PHONY: help setup format test validate

help: ## Show the available commands
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  %-10s %s\n", $$1, $$2}'

setup: ## Install dependencies and Git hooks
	npm install
	prek install

format: ## Run every formatter, linter, and type check
	prek run --all-files

test: ## Run the test suite
	npm exec --no -- vitest run

validate: format test ## Everything that must pass before work is done

# Project-specific targets live in Makefile.local, never here: `copier
# update` regenerates this file and would clobber anything added directly
# below. The leading `-` makes a missing Makefile.local a no-op. Targets
# documented with a `## ` comment there show up in `make help` too, since
# `$(MAKEFILE_LIST)` includes included files.
-include Makefile.local
