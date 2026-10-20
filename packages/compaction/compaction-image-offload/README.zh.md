---
description: "面向组合 compaction 的部署的图片省略执行器说明：支持图片的路由以请求超出图片预算拒绝时会发生什么。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-image-offload

[English](README.md) | 中文

## 概述

当较早的图片超出模型路由的预算时，图片密集的会话仍可继续。本插件永久将这些图片替换为注明附件及其可用只读路径的文本，然后重试，不消耗提供方重试预算。配置后，工具结果中的图片在模型此后回复达到设定次数时也会从请求中移除，长时间的视觉会话因此不再重复发送模型已经判断过的截图和渲染帧。后续请求在切换路由、恢复和回放时都保留这一选择。token 计量随日志记录的选择更新，提供方缓存只能复用到第一条被修改的消息之前。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

凡是运行 agent loop（智能体循环）并带有支持图片的路由的组合，都应挂载本插件，随附的 `dsh` 基础配置已经挂载，并设置 `toolImageMaxAgeSteps: 5`。没有它，`IMAGE_OFFLOAD_REQUIRED` 失败会进入普通恢复并以错误结束该轮次。路由预算无需配置：DeepSeek 适配器执行其 file 模式和内联回退预算，pi-ai 适配器执行其 base64 上限，各自上报需要省略的数量。

`toolImageMaxAgeSteps`（非负整数，可选）在当前表层上某个 `tool/result` 图片之后出现该数量的 `assistant/message` 节点时，省略这张仍被保留的图片。检查在 `agent/pre-step` 上、每一步请求之前进行，适用于包括子智能体在内的所有 agent。因此一张图片会出现在它到达后的 `toolImageMaxAgeSteps` 步请求中。`user/message` 中的图片从不按时间省略。未设置该字段或设为 `0` 时，图片只会通过路由预算恢复离开请求。

### 最小可用组合

```yaml
- name: '@deepseek-ai/dsh-compaction-image-offload'
  config:
    toolImageMaxAgeSteps: 5
```

### 你可以观察到什么

每次决定追加一条 `image/offload` 事件，通过当前消息事件的序号和消息内深度优先的图片序号指定省略位置。消息事件和表层节点标识保持不变。agent 重试前会追加新的 `request/header`，标明新的消息序列。按时间省略的决定位于首次省略这些图片的那一步请求之前；没有新到期图片的步骤不记录任何内容。摘要重试保留在同一对压缩标记内。

### 失败与恢复

本插件只处理带 `offloadImages` 的 `IMAGE_OFFLOAD_REQUIRED` 失败。它按模型请求顺序遍历表层，跳过 assistant 节点和已经标记的图片，给指定数量的出现位置打标记。没有可省略的图片时在 `agent/request-error` waterfall 上委派下游，由下游恢复或普通的轮次错误处理。这次重试不占提供方重试预算，也不追加 `llm/retry` 事件。记录选择前发生取消时会委派后续处理，不新增 `image/offload` 事件；选择提交后发生取消时停止重试，但保留省略记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本包拥有事件声明、引用校验、不可变图片投影、选图和重试策略。它在接受图片省略事件前向 Session 注册 `imageOffloadProjection`。相同的浏览器安全处理器通过 `./projection` 导出，供独立回放使用，当前格式目录为离线读取器装配该处理器。缺少注册时拒绝实时恢复，卸载已经使用的处理器后拒绝继续派生消息。token 测量应用同一份选择，不依赖替换影子价格。

摘要失败使用同步的 `compaction/summary-error` waterfall。插件只在传入的摘要选区内选图，记录省略后返回 true。压缩后端重新派生该选区并计价，然后重试。每次重试都会继续省略保留的图片，没有可省略的位置时结束恢复。取消或无关的选区变更会使摘要失败。已经记录的省略在后续失败或取消后仍然有效。

纯投影在 Session 提交事件前拒绝无效或重复省略的图片引用，执行器不维护独立可变的省略状态。

按时间省略读取仅限 host 的 `toolImageAge` Session 投影，本插件只在 `toolImageMaxAgeSteps` 为正数时注册它。该投影累计 `assistant/message` 事件数，并为每个 `tool/result` 节点记录图片到达时的计数和尚未省略的图片序号；替换会移除其来源，替换用的 `tool/result` 保留最早的到达计数。和所有投影一样，恢复会话时会还原该累计状态，因此选图从不读取历史事件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [独立的图片省略事件](../../../.agents/notes/implemented/architecture/2026-09-10-image-offload-events.zh.md)，记录持久选择、职责和被否决的方案。
- [compaction seam](../compaction/README.zh.md)，相邻的摘要和文本剪枝操作。
- [compaction-tool-result-pruner](../compaction-tool-result-pruner/README.zh.md)，保留图片选择并修剪工具输出的兄弟执行器。
- [dsh-llm](../../llm/llm/README.zh.md)——`ImageBlock.offloaded`、`IMAGE_OFFLOAD_REQUIRED` 与占位投影。
- [llm-deepseek 适配器](../../llm/llm-deepseek/README.zh.md)与 [llm-pi-ai 适配器](../../llm/llm-pi-ai/README.zh.md)——上报省略数量的路由预算。

-----

<a id="model-experience"></a>
## 模型体验

### 已省略的请求图片

#### 模型看到的内容

每个选中的图片出现位置以占位文本（`offloadedImageText`）到达模型，文本说明该图片已从本次请求中省略，并注明附件及其可用只读路径，未选中的位置仍是图片。文本不区分预算恢复和按时间省略。选择在后续请求中持续生效。新的工具读取可以引入同一附件的新出现位置，不会恢复旧位置。模型自己对按时间省略的图片所写的文本和推理保留在历史中。

#### Token 影响

被省略的出现位置只花费占位文本，不再花费视觉 token。token meter 为每个节点定价时应用日志记录的选择。仅针对引用的启发式计数不计入省略元数据。

#### KV Cache 影响

一次选择把较早的图片换成占位文本，该请求的提供方缓存复用因此止于第一张被修改的图片。所选位置之后仍保持省略。按时间省略只选择已经过 `toolImageMaxAgeSteps` 次回复的图片，因此该请求未命中缓存的后缀大约是最近 `toolImageMaxAgeSteps` 步。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **被省略的图片不会自动回归**——更大的预算、更大的路由或 compaction 降低总量都不会移除标记；恢复手段是占位文本中的只读路径。
- **每次省略都要先失败一次**——发送前没有任何规划，路由的拒绝就是信号，这和计划中改由 provider 报告无法缓存图片的方向一致。
- **临时的小预算会永久省略**——迫使内联回退的 Files 故障，或临时切到小预算路由，会省略后来的路由本可以发送的图片。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本开发备注是非权威的工作背景：给维护者的备注和未决问题。已交付的行为与被接受的理由见上文各节、包代码和链接的 Agent Note。

- 产生 `IMAGE_OFFLOAD_REQUIRED` 的路由本地字节检查是过渡实现：provider 自己报告无法缓存的图片之后，adapter 把该报告换算成数量，本执行器保持不变。

</details>
