---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-30-dublin-memory

[English](2026-10-30-dublin-memory.md) | 中文

## 概述

新增仅用于日志的事件，记录 Dublin Lab 记忆提炼及整理的独立请求和结果。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-30-dublin-memory
baseline: false
changes:
  - root: "event:dublin/memory-call"
    previous: null
    after: "be9f6eb85db4e9722f82beefc713d43c25ab60d052a4b62410c2ff220b53e34a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录及回放语义不变。新增事件不建立聊天轮次，读取方可忽略；请求及结果保留所选服务、模型、精确提示和输出以供检查，无需提高写入版本。

<a id="verification"></a>
## 验证

20 个存储、运行时及界面专项测试通过，覆盖历史导入确认、凭据脱敏、调用日志、范围隔离、删除保护和向量回退及跨站 API 拒绝。

<a id="dev-note"></a>
## 开发备注

无。
