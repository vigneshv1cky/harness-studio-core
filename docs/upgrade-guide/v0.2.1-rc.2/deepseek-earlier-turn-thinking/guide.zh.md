---
kind: upgrade-guide
description: "发往默认 deepseek-flash 路由的请求会省略当前 user 消息之前各轮次的思考块。"
---

# DeepSeek 较早轮次思考省略

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-llm-deepseek` 的目录条目可以声明 `reasoningHistory: current-turn`，默认的 `deepseek-flash` 条目现已声明。在这样的路由上，Messages 请求会从最后一条不含工具结果的 user 消息之前的每条 assistant 消息中省略 `thinking` 块；当前轮次的思考（包括跨工具调用和轮次中途通知的部分）仍连同签名发送，较早轮次中只含思考的 assistant 消息保留其思考。此前每个轮次的思考都会传回。Session 日志不变，只有请求体不同。

`deepseek-flash` 端点要求传回较早轮次思考的部署，以及跨版本比较请求大小或缓存复用的客户端会受影响：输入 token 减少，每个新轮次的首次请求会把上一轮次未缓存地重新读取一次。该设置及其 token 与缓存影响见[包参考](../../../../packages/llm/llm-deepseek/README.zh.md)。

## 迁移

1. 接受新默认值，或在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中用不含该设置的条目替换目录，以保留每个轮次的思考：

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

2. 若要在其他路由上启用该设置，在该模型的目录条目中加入 `reasoningHistory: current-turn`；其他任何值都会在加载时失败。
3. 运行两个使用思考的轮次。不使用 patch 时，第二个轮次首次请求报告的输入 token 少于第一个轮次最后一次请求加上新消息；使用 patch 时，计数仍像以前一样随较早的思考增长。
