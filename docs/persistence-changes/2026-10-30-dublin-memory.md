---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-30-dublin-memory

English | [中文](2026-10-30-dublin-memory.zh.md)

## Summary

Adds a log-only event for auxiliary Dublin Lab memory extraction and consolidation requests and results.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records and replay semantics are unchanged. The additive event does not create conversation turns; readers may ignore it, while request and result data preserve the exact selected provider/model prompt and output for inspection. No writer version bump is required.

<a id="verification"></a>
## Verification

20 focused store/runtime/UI tests passed, including explicit history consent, credential redaction, logged calls, scope isolation, deletion guards and embedding fallback and cross-site API rejection.

<a id="dev-note"></a>
## Dev Note

None.
