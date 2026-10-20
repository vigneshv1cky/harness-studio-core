---
description: "The image offload executor for deployments composing compaction: what happens when an image-capable route rejects a request as over its image budget."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-image-offload

English | [中文](README.zh.md)

## Summary

Image-heavy conversations continue when older images exceed a model route's budget. The plugin permanently replaces those images with text naming each attachment and its available read-only path, then retries without spending the provider retry budget. When configured, it also removes tool-result images from requests once the model has responded a set number of times after them, so long visual sessions stop resending screenshots and rendered frames the model has already judged. Later requests retain that choice across route changes, resume, and replay. Token accounting follows the logged selections, and provider cache reuse ends at the first changed message.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in every composition that runs the agent loop with an image-capable route. The shipped `dsh` base does, with `toolImageMaxAgeSteps: 5`. Without it, an `IMAGE_OFFLOAD_REQUIRED` failure reaches ordinary recovery and ends the turn as an error. Route budgets need no configuration: the DeepSeek adapter enforces its file-mode and inline-fallback budgets, the pi-ai adapter its base64 bound, and each reports the count it needs offloaded.

`toolImageMaxAgeSteps` (non-negative integer, optional) omits every retained `tool/result` image once that many `assistant/message` nodes follow it on the current surface. The check runs on `agent/pre-step`, before each step's request, for every agent including subagents. An image therefore reaches the requests of the `toolImageMaxAgeSteps` steps after it arrived. `user/message` images are never aged out. Without the field, or with `0`, images leave requests only through route-budget recovery.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-compaction-image-offload'
  config:
    toolImageMaxAgeSteps: 5
```

### What you can observe

Each decision appends one `image/offload` event identifying the selected occurrences by current message-event sequence and depth-first image index. The message events and surface node identities remain unchanged. An agent retry follows a fresh `request/header` identifying a new message series. An age-out decision precedes the step whose request first omits those images; a step with no newly aged image records nothing. Summary retries remain inside the same compaction bracket.

### Failures and recovery

The plugin acts only on `IMAGE_OFFLOAD_REQUIRED` failures that carry `offloadImages`. It walks the surface in model request order, skips assistant nodes and images already marked, and marks that many occurrences. When nothing remains to offload it delegates on the `agent/request-error` waterfall, so downstream recovery or the ordinary turn error applies. The retry spends no provider retry budget and logs no `llm/retry` event. Cancellation before recording a selection delegates without adding an `image/offload` event; cancellation after a committed selection stops retry but preserves the omission.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This package owns the event declaration, reference validation, immutable image projection, selection, and retry policy. It registers `imageOffloadProjection` with Session before accepting image-offload events. The same browser-safe definition is exported from `./projection` for detached replay; the installed format catalog assembles it for offline readers. Missing registration rejects live restore, and unloading a used definition blocks further message derivation. Token measurement folds the same selections without replacement shadow prices.

Summary failures use the synchronous `compaction/summary-error` waterfall. The plugin selects only the supplied summary region and returns true after recording an omission. The compaction backend re-derives and re-prices that region before retrying; each retry omits additional retained occurrences, so recovery ends when none remain. Cancellation and unrelated selection changes reject the summary. Recorded omissions survive later failure or cancellation.

The pure projection rejects invalid or repeated image references before Session commits the event, and this executor retains no separate mutable offload state.

Age-out reads the host-only `toolImageAge` Session projection, which this plugin registers only when `toolImageMaxAgeSteps` is positive. It folds the count of `assistant/message` events and, per `tool/result` node, the arrival count and indexes of its images not yet offloaded; replacements drop their sources and a replacing `tool/result` keeps the earliest arrival. The fold is restored on resume like every projection, so selection never reads historical events.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Dedicated image-offload events](../../../.agents/notes/implemented/architecture/2026-09-10-image-offload-events.md) — durable selections, ownership, and rejected alternatives.
- [compaction seam](../compaction/README.md) — the neighboring summary and text-pruning operations.
- [compaction-tool-result-pruner](../compaction-tool-result-pruner/README.md) — the sibling executor that trims tool outputs while preserving image selections.
- [dsh-llm](../../llm/llm/README.md) — `ImageBlock.offloaded`, `IMAGE_OFFLOAD_REQUIRED`, and the placeholder projection.
- [llm-deepseek adapter](../../llm/llm-deepseek/README.md) and [llm-pi-ai adapter](../../llm/llm-pi-ai/README.md) — the route budgets that report offload counts.

-----

<a id="model-experience"></a>
## Model Experience

### Offloaded request images

#### What the model sees

Every selected image occurrence reaches the model as placeholder text (`offloadedImageText`) stating that the image is omitted from this request and naming the attachment and its available read-only path; unselected occurrences stay images. The text does not distinguish budget recovery from age-out. Selections persist across requests. A new tool read may introduce a new occurrence of the same attachment without restoring the old one. The model's own text and reasoning about an aged-out image remain in history.

#### Token effect

An offloaded occurrence costs its placeholder text instead of visual tokens. The token meter applies the logged selections when pricing each node. Reference-only heuristic counts exclude offload metadata.

#### KV Cache effect

A selection turns earlier images into placeholder text, so provider cache reuse ends at the first changed image for that request. The selected occurrences remain omitted afterwards. Age-out selects only images `toolImageMaxAgeSteps` responses old, so the uncached suffix of that request is about the last `toolImageMaxAgeSteps` steps.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Offloaded images never return automatically** — a larger budget, a larger route, or compaction lowering the total leaves the marks in place; recovery is the read-only path in the placeholder.
- **Every offload costs one failed attempt** — nothing plans an offload before dispatch; the route's rejection is the signal, which matches the planned move to provider-reported uncacheable images.
- **A temporary small budget offloads permanently** — a Files outage that forces the inline fallback, or a temporary switch to a small-budget route, offloads images a later route would have sent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The route-local byte checks that produce `IMAGE_OFFLOAD_REQUIRED` are provisional: once the provider reports uncacheable images itself, the adapters map that report to a count and this executor stays as it is.

</details>
