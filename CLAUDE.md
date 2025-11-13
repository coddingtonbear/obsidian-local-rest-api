# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

IMPORTANT: in all interactions and commit messages, be extremely concise and sacrifice grammar for the sake of concision.

## Project Overview

This is an Obsidian plugin that exposes a secure REST API for programmatic interaction with Obsidian vaults. It allows external tools and automation to read, create, update, delete notes, execute commands, and search content via HTTP/HTTPS requests.

# Development Guidelines

## Test-Driven Development

Write tests before implementing functionality. Follow this cycle:

1. Write a failing test that defines the desired behavior
2. Implement the minimum code needed to make the test pass
3. Refactor while keeping tests green

When creating new features or fixing bugs, start by adding or modifying tests. Ensure all tests pass before considering work complete. Place tests in appropriate directories following the project's existing test structure.

## GitHub Issue Integration

Before starting work, check if a relevant GitHub issue exists. If working on a specific issue, reference it in commit messages using the issue number (e.g., "Fixes #123" or "Addresses #123").

When encountering bugs or identifying potential improvements during development, create GitHub issues to track them rather than immediately implementing fixes outside the current scope.

For significant changes, review related issues to understand context and avoid duplicate work. Update issue status and add comments when making meaningful progress.

## Code Quality

Maintain consistency with existing code style and architecture patterns. Keep changes focused on the task at hand. Write clear commit messages that explain why changes were made, not just what changed.


## Development Commands

### Build and Development
- `npm run dev` - Start development build with watch mode (uses esbuild)
- `npm run build` - Build for production (runs TypeScript type checking first, then esbuild bundle)
- `npm test` - Run Jest test suite

### Documentation
- `npm run build-docs` - Generate OpenAPI documentation from Jsonnet source
- `npm run serve-docs` - Serve Swagger UI for API documentation (requires Docker)

## Architecture

### Core Components

**Main Plugin (`src/main.ts`)**
- `LocalRestApi` class: Plugin entry point that manages HTTPS/HTTP server lifecycle
- Generates self-signed certificates on first run using node-forge
- Creates secure (HTTPS on port 27124) and optional insecure (HTTP on port 27123) servers
- Delegates request handling to `RequestHandler`

**Request Handler (`src/requestHandler.ts`)**
- `RequestHandler` class: Core Express.js application that defines all API routes
- Implements bearer token authentication middleware
- Handles all vault operations (read/write/patch/delete files)
- Supports periodic notes (daily, weekly, monthly, yearly)
- Implements search functionality (simple search and JSON logic queries)
- Provides command execution capabilities
- Uses markdown-patch library for PATCH operations on notes

**Public API (`src/api.ts`)**
- `LocalRestApiPublicApi` class: Allows other Obsidian plugins to register custom API extensions
- Plugins get their own Express router to add custom routes
- Extensions can be unregistered when plugins unload

### Key API Endpoints

The plugin exposes these endpoint categories:
- `/active/` - Operations on currently active file
- `/vault/*` - Operations on vault files by path
- `/periodic/:period/` - Daily/weekly/monthly/yearly note operations
- `/commands/` - List and execute Obsidian commands
- `/search/` - Content search with various query methods
- `/open/*` - Open files in Obsidian

All endpoints (except certificate and docs) require bearer token authentication via `Authorization` header.

### Testing

The test suite uses Jest with ts-jest for TypeScript support. Tests mock the Obsidian API using `mocks/obsidian.ts`. The main test file is `src/requestHandler.test.ts`.

To run a single test file:
```bash
npm test -- requestHandler.test.ts
```

### Build Process

Uses esbuild for bundling:
- Entry point: `src/main.ts`
- Output: `main.js` (CommonJS format)
- External dependencies: Obsidian API and built-in Node modules
- YAML files loaded as text (for OpenAPI spec embedding)
- Development builds include inline source maps

### TypeScript Configuration

- Target: ES6
- Module: ESNext with Node resolution
- Strict type checking enabled (`noImplicitAny`)
- Test files excluded from main compilation

## Important Patterns

### Authentication
All API requests (except `/`, certificate endpoint, and OpenAPI spec) require bearer token authentication. The API key is auto-generated on first run using SHA-256 hash of random bytes.

### Content Types
The API accepts multiple content types:
- `text/markdown` - Standard markdown content
- `application/json` - JSON data
- `application/vnd.olrapi.note+json` - Special note format with frontmatter
- `application/vnd.olrapi.jsonlogic+json` - JSON Logic queries for filtering
- `application/vnd.olrapi.dataview.dql+txt` - Dataview query language

### PATCH Operations
Uses the `markdown-patch` library for structured updates. Supports:
- Heading-based insertions (specify heading boundary and position)
- Target-based patches with operation types (insert, append, prepend, replace)
- Content-type-aware patching

### Certificate Management
Self-signed certificates are auto-generated with:
- 2048-bit RSA keypairs
- 365-day validity
- Subject Alternative Names support for custom hostnames
- Must be trusted by client browsers for HTTPS connections
