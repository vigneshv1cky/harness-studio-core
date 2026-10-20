---
kind: upgrade-guide
description: "基于 base 的 profile 会在工具结果图片到达后模型回复五次时将其移出请求，图片占位文本改用新措辞。"
---

# 工具结果图片按时间省略

[English](guide.md) | 中文

## 变更

基于 `@deepseek-ai/dsh-base` 的 profile 以 `toolImageMaxAgeSteps: 5` 挂载 `@deepseek-ai/dsh-compaction-image-offload`。每一步之前，凡是其后已有五个 `assistant/message` 节点的 `tool/result` 图片，都会记录在 `image/offload` 事件中，并在后续请求中以注明附件及其只读路径的占位文本出现。`user/message` 事件中的图片保留不变。此前只有在路由以超出图片预算拒绝请求时，图片才会离开请求。所有占位文本（包括预算情形）现在以 `image omitted from this request;` 开头，取代 `image omitted to fit request image limits;`。

对提示词大小做基准测试、统计 `image/offload` 事件或匹配占位文本的客户端必须考虑这两项变化。设置及其 token 与缓存影响见[包参考](../../../../packages/compaction/compaction-image-offload/README.zh.md)。

## 迁移

1. 接受新默认值，或将以下 patch 写入 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，使工具结果图片保留到路由拒绝为止：

```yaml
- id: image-offload
  config:
    toolImageMaxAgeSteps: 0
```

2. 将对占位文本的匹配更新为新前缀。
3. 运行一个读取图片后再执行六步的轮次。使用该 patch 时，Session 日志不含 `image/offload` 事件；不使用时，会有一个事件在第六步之前选中该图片。
