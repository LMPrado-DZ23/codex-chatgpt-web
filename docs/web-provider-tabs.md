# ADR: multi-provider web AI (design C — hybrid)

Status: accepted (2026-10-19). Scope: this fork only; upstream keeps ChatGPT Web as its single
provider (see `CONTRIBUTING.md`).

## Context

`codex-chatgpt-web` serves one Responses API on loopback and routes model slugs to a provider:
`chatgpt-web/*` through the launcher-owned Electron browser, everything else proxied to the native
OpenAI upstream. The goal is to use other web AIs next to ChatGPT in the same Codex model picker.

Two very different providers exist today:

- **ChatGPT Web** — embedded in the launcher (`WebContentsView`, partition
  `persist:codex-web-gpt-chatgpt`), driven by the browser worker, with the OpenAI tunnel/MCP
  connector for Full harness. Mature; must keep working unchanged.
- **DeepSeek Web** — external `deepseek-web-bridge` process with its own headless Chrome profile,
  exposed over local HTTP chat-completions. Integrated through `src/adapters/deepseek-web` and the
  generic `webProviders` registry. No launcher UI, no tunnel.

## Decision

Adopt the hybrid model:

1. **ChatGPT stays embedded** in the launcher and keeps the Full harness/MCP path.
2. **External bridges stay external** while they are the cheapest reliable integration (DeepSeek
   today). They appear in the Codex picker via the provider registry and are configured per
   installation (`deepseekWebBridgeUrl` / `webProviders`).
3. **The launcher gets provider tabs** (phase 2) for providers whose browser session the launcher
   owns — starting with Claude Web and Gemini Web, which have no bridge today. Each provider tab is
   a first-class browser surface with its own partition and login.
4. A provider may later move from "external bridge" to "launcher tab" without changing the model
   slugs, because routing is by slug and the adapter behind it is replaceable.

## Architecture (phase 2 — launcher tabs)

```
launcher window
├─ provider tab row           ChatGPT | Claude | Gemini | (DeepSeek: status only)
├─ task tab strip (per provider, cap 5)
└─ WebContentsView per provider
   ChatGPT  → persist:codex-web-gpt-chatgpt
   Claude   → persist:codex-web-gpt-claude
   Gemini   → persist:codex-web-gpt-gemini
```

- `launcher/electron/profile.cjs`: one partition id per provider
  (`persist:codex-web-gpt-<provider>`; DEV profile variants included). The partition becomes part of
  the profile descriptor, not a hard-coded constant.
- `launcher/electron/browser-host.cjs`: the current single surface becomes a provider registry:
  `providers: Map<providerId, { partition, view, tabs: Map, selectedTabId, cap }>`.
  `MAX_BROWSER_TABS` (5) becomes per provider. Snapshots expose `providers[]` plus the active one.
  Turn leases keep their existing semantics, scoped to a provider.
- `launcher/src/App.tsx`: provider row above the existing `browser-tab-strip`; selecting a provider
  switches the visible `WebContentsView` and the bound model prefix. Only providers with a configured
  adapter/bridge are enabled.
- `preload.cjs`/IPC: `listWebProviders`, `selectWebProvider`, `providerStatus` (health for external
  bridges, login state for embedded ones).
- Model binding: `chatgpt-web/*` → ChatGPT tab; `<provider>/*` → that provider's tab (or external
  bridge). A turn for a provider whose surface is unavailable fails closed with an explicit error.
- i18n: provider labels and states in all six locales (en, zh-CN, zh-TW, ja, ko, pt-BR).

## Security invariants

- Each provider gets an isolated Electron partition; cookies, storage and logins never cross
  providers. A ChatGPT session is never presented to another provider.
- External bridges stay loopback-only and keep their own browser profile; the launcher only stores
  the URL.
- The OpenAI tunnel/MCP connector remains exclusive to the ChatGPT path. Other providers never
  receive the connector capability.
- A provider failure (login expired, DOM drift, bridge down) must fail closed with an actionable
  message; no silent fallback to another provider or model.

## Phases

1. **Provider registry** (done): `webProviders` config, generic bridge adapter and route, catalog
   rows, DeepSeek built-in provider, validation tests.
2. **Launcher tabs shell**: partitions + provider tab row + login surfaces for Claude/Gemini, with
   external providers shown as status-only entries. No model automation yet; browsing/login only.
3. **Claude Web adapter**: DOM contract + fixtures, streaming, tool relay (Claude web has remote MCP
   connectors, unlike the others), login recovery. Estimated 2–4 weeks plus ongoing DOM maintenance.
4. **Gemini Web adapter**: same shape, no MCP; browser-only tool protocol. Estimated 2–4 weeks.
5. **Optional**: move DeepSeek into the launcher once its bridge work is stable.

## Consequences

- Positive: ChatGPT path untouched; new providers are additive; the picker stays single; provider
  isolation is explicit; external bridges can ship independently.
- Negative: two lifecycle models (embedded vs external) to document; per-provider partitions multiply
  disk usage; every web adapter adds DOM-maintenance cost and account/ToS risk.
- Rejected: a single browser surface shared by providers (cookie/login bleed, impossible tab caps);
  generic API providers inside this bridge (Codex already talks to them directly, no browser value).
