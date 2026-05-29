# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Adapter is a local HTTP proxy that translates between the Anthropic API format and OpenAI-compatible endpoints. It allows Claude Code to use models from any OpenAI-compatible provider (OpenAI, DeepSeek, Groq, XAI, Mistral, etc.).

Flow: `Claude Code → adapter (localhost:3080) → OpenAI-compatible API`

## Commands

```bash
npm install           # Install dependencies
npm run build         # Compile TypeScript to dist/
npm run dev           # Run CLI with ts-node (dev mode)
npm start             # Run compiled CLI from dist/
npm test              # Run all Jest tests
npm test -- --watch   # Watch mode
npm test -- tests/request.test.ts  # Run a single test file
npm test -- --coverage             # Run with coverage report
npm run lint          # ESLint check (src/**/*.ts tests/**/*.ts)
npm run format        # Prettier format all code
claude-adapter        # Run setup wizard (interactive)
claude-adapter -p 3000             # Custom port
claude-adapter --reconfigure       # Force reconfigure
```

Node.js >= 20.0.0 required.

## Architecture

The codebase is organized into four main modules under `src/`:

### Converters (`src/converters/`)
Bidirectional format translation:
- `request.ts` — Anthropic request → OpenAI request
- `response.ts` — OpenAI response → Anthropic response
- `streaming.ts` — OpenAI SSE → Anthropic SSE (real-time streaming)
- `xmlStreaming.ts` — XML-mode streaming (for models without native tool support)
- `tools.ts` — Tool/function call conversion
- `xmlPrompt.ts` — XML tool instructions generation

### Server (`src/server/`)
Fastify-based HTTP server:
- `index.ts` — Server factory (`createServer`)
- `handlers.ts` — Request handlers for `/v1/messages` and other endpoints

### Types (`src/types/`)
TypeScript interfaces for Anthropic API, OpenAI API, and adapter config.

### Utils (`src/utils/`)
- `config.ts` — Config loading/saving (`~/.claude-adapter/config.json`)
- `logger.ts` — Structured logging with request IDs
- `metadata.ts` — Token usage tracking
- `validation.ts` — Request validation
- `update.ts` — Non-blocking version checks

### Entry Points
- `src/cli.ts` — CLI entry point with interactive setup wizard (commander + inquirer)
- `src/index.ts` — Library exports (`createServer`, converters, types)

## Key Patterns

**Tool Calling**: Two modes — `native` (OpenAI function calling) and `xml` (universal fallback for models without tool support). The `toolFormat` config option selects between them.

**ID Deduplication**: The adapter handles duplicate tool IDs that may appear across Anthropic messages.

**Streaming**: Full SSE support. The streaming converters transform OpenAI server-sent events into Anthropic-format events in real time.

**Assistant Prefilter**: Filters out Anthropic-specific prefill tokens that shouldn't reach the upstream model.

## Runtime Config

User config lives at `~/.claude-adapter/config.json`:
```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "models": {
    "opus": "gpt-4o",
    "sonnet": "gpt-4o-mini",
    "haiku": "gpt-4o-mini"
  },
  "toolFormat": "native"
}
```

Claude Code settings (`~/.claude/settings.json`) are auto-updated with `ANTHROPIC_BASE_URL` pointing to `http://localhost:3080` and `ANTHROPIC_AUTH_TOKEN` set to `default`.

## Testing

Jest with ts-jest. Tests live in `tests/` with `.test.ts` suffix. Match existing test patterns and conventions. Coverage excludes `cli.ts` and `index.ts`.

## Style

- TypeScript strict mode, ES2022 target, CommonJS modules
- ESLint + Prettier (semicolons, single quotes, tabWidth 2, printWidth 100)
- File naming: kebab-case (`request-converter.ts`)
- Functions: camelCase, Interfaces: PascalCase, Constants: UPPER_SNAKE
