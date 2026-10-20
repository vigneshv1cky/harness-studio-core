---
kind: upgrade-guide
description: "Base-backed profiles omit tool-result images from requests five model responses after they arrive, and image placeholders use new wording."
---

# Tool-result image age-out

English | [中文](guide.zh.md)

## Change

Profiles built on `@deepseek-ai/dsh-base` mount `@deepseek-ai/dsh-compaction-image-offload` with `toolImageMaxAgeSteps: 5`. Before each step, every `tool/result` image that five `assistant/message` nodes follow is recorded in an `image/offload` event and reaches later requests as placeholder text naming the attachment and its read-only path. Images in `user/message` events are kept. Previously images left requests only when a route rejected a request as over its image budget. Every placeholder, including the budget case, now begins `image omitted from this request;` instead of `image omitted to fit request image limits;`.

Clients that benchmark prompt size, count `image/offload` events, or match placeholder text must account for both changes. See the [package reference](../../../../packages/compaction/compaction-image-offload/README.md) for the setting and its token and cache effects.

## Migration

1. Accept the new default, or place this patch in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` to keep tool-result images until a route rejects them:

```yaml
- id: image-offload
  config:
    toolImageMaxAgeSteps: 0
```

2. Update any text matching of placeholders to the new prefix.
3. Run a turn that reads an image and then takes six more steps. With the patch, the Session log contains no `image/offload` event; without it, one event selects that image before the sixth step.
