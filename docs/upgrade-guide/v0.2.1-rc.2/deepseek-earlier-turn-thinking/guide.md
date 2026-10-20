---
kind: upgrade-guide
description: "Requests to the default deepseek-flash route omit thinking blocks from turns before the current user message."
---

# DeepSeek earlier-turn thinking omission

English | [中文](guide.zh.md)

## Change

A `@deepseek-ai/dsh-llm-deepseek` catalog entry may declare `reasoningHistory: current-turn`, and the default `deepseek-flash` entry now does. On such a route the Messages request omits `thinking` blocks from every assistant message before the last user message that carries no tool result; the current turn's thinking, including across tool calls and mid-turn notices, is still sent with its signatures, and an earlier assistant message holding only thinking keeps it. Previously every turn's thinking was passed back. Session logs are unchanged; only request bodies differ.

Deployments whose `deepseek-flash` endpoint requires earlier turns' thinking, and clients that compare request sizes or cache reuse across versions, are affected: input tokens fall, and the first request of each new turn re-reads the previous turn uncached once. The [package reference](../../../../packages/llm/llm-deepseek/README.md) describes the setting and its token and cache effects.

## Migration

1. Accept the new default, or keep every turn's thinking by replacing the catalog in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` with entries that omit the setting:

```yaml
- id: llm-deepseek
  config:
    models:
      - id: deepseek-flash
        name: DeepSeek-V4.1-Flash
        inputModalities: [text, image]
        systemPromptUpdate: in-history
        toolUpdate: addition-only
      - id: deepseek-v4-pro
        name: DeepSeek-V4-Pro
```

2. To enable the setting on another route, add `reasoningHistory: current-turn` to that model's catalog entry; any other value fails at load.
3. Run two turns that use thinking. Without the patch, the second turn's first request reports fewer input tokens than the first turn's last request plus the new message; with it, the counts grow by the earlier thinking as before.
