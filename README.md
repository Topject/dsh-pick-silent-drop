# dsh-pick-silent-drop

**DSH 工作区选择静默丢弃**——一次"新建对话时选中工作区会闪回、并在 Host 留下空白会话"的排查产物。
每个结论都对应可执行证据，并明确区分**已确证**与**未确证**。

## 问题与结论

**问题**：点「新建对话」→ 选工作区 → 界面闪回"选择工作区"，控制台无报错，侧边栏不出现新会话。
**结论**：**后端一直成功，前端把已创建的会话静默丢弃了**——70 秒内留下 20 个孤儿会话，界面上却"什么都没发生"。
**解法**：不信界面，只信落盘数据；再顺代码找到那条静默分支，并用探针等它复现时抓栈。

> **诚实边界**：丢弃行为与"静默"本身**已确证**（代码 + 被测试固定的契约 + 落盘数据）；
> 但**触发它的时序是间歇性的**，未稳定复现，因此不写成确定性根因。
> 详见[第 4 节](#问题谁顶掉了哪一次导航缺陷已确证触发源未知)与[状态](#状态与来源)。

> 全部代码引用指向上游公开仓库 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，
> 行号基于 `master` @ [`5badb15`](https://github.com/deepseek-ai/deepseek-harness/commit/5badb15009)。
> 本机运行的是 `0.2.0-rc.2`，诊断所读源码为 `0.2.1-alpha.1`，**两处均已实测含有下述分支**。

---

## 目录

**章节导航**（四个"问题"连起来就是完整调查链：无从下手 → 为什么无痕 → 触发点在哪 → 怎么防）

1. [问题：排查第一步就无从下手](#问题排查第一步就无从下手) — 忽略界面，去查落盘
2. [问题：失败为什么无声又无痕](#问题失败为什么无声又无痕) — 找到"静默"是刻意设计
3. [问题：界面闪回的触发点在哪](#问题界面闪回的触发点在哪) — 顺乐观更新与失败回滚往回找
4. [问题：谁顶掉了哪一次导航（缺陷已确证，触发源未知）](#问题谁顶掉了哪一次导航缺陷已确证触发源未知) — 常驻探针 + 已排除的假设
5. [问题：怎么防止再犯](#问题怎么防止再犯) — 两处必修 + 一处待定
6. [状态与来源](#状态与来源) — 校验结果、版本、提交

**文件说明**

| 文件 | 作用 |
|---|---|
| `README.md` | 本文：问题 → 排查链 → 证据 → 状态 |
| `abort-probe.console.js` | **控制台探针**：捕获导航取消及调用栈（零改包，粘进 DevTools 即可） |
| `self-test.js` | 探针自测：证明它能记录 UI 帧、过滤传输噪声、重启后不丢（13 项） |
| `verify-deliverables.js` | 交付物校验：spec 结构 / asar 哈希 / 编码（16 项） |
| `extract-asar.js` | 从 `app.asar` 提取指定包，用于核对真实 bundle |
| `dsh-cleanup-blank-sessions.ps1` | 清理孤儿空白会话（默认预览，先备份后写入） |
| `DISCUSSIONS-POST.md` | 可直接粘贴到上游 Discussions 的 Bug 报告 |
| `PUBLISH-GUIDE.md` | 发布到 GitHub 的操作步骤 |

```bash
node self-test.js             # 探针自测
node verify-deliverables.js   # 交付物完整性
```

---

## 问题：排查第一步就无从下手
**解法：忽略界面，去查落盘。** 后端记录不会骗人：

- `~/.dsh/storages/workspace.json`：APPO **16** 个、default-workspace **7** 个空白会话
- 判据取投影缓存：`sessionListMetadata.blank === true` + 无 title + `titleInput.count === 0`

> **陷阱**：本版本 `session.v4.jsonl.zstd` 连真实对话也只有一行会话头。
> 用"日志只有头部"判空，会**删掉全部 8 个真实对话**。

---

## 问题：失败为什么无声又无痕
**解法：找到"静默"是刻意设计。** 会话已创建，却在导航被顶掉时直接 return：

[`packages/client/ui-workspace/src/client/navigation.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/src/client/navigation.ts#L210-L223)

```ts
sessionId = await this.connectWorkspace(workspaceId)   // Host 已在此创建会话
...
if (navigation.aborted) return      // ← 不 retain、不回收、不提示
this.replaceMain(sessionId, navigation, 'reveal', beforeOpen)
```

这被测试固定为预期行为
（[`workspaces-service.client.spec.ts:501`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/tests/workspaces-service.client.spec.ts#L501)）：

```ts
it.each(['disposal', 'a later navigation'])('keeps a creation refused after %s silent', async () => {
  expect(b.notify).not.toHaveBeenCalled()      // ← 断言：必须静默
})
```

又因为**空白会话只在被选中时显示**，失败既没有声音、也没有痕迹。

---

## 问题：界面闪回的触发点在哪
**解法：顺着"乐观更新 + 失败回滚"往回找。** 错误对象被丢弃：

[`packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx#L123-L129)

```ts
void selectWorkspace(workspaceId).catch(() => {     // ← error 被丢掉
  setPendingWorkspaceId(current => current === workspaceId ? undefined : current)
})
```

而"切换面板会取消进行中的导航"是显式设计
（[`ui-layout/src/client/service.ts:72-85`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/src/client/service.ts#L72-L85)，
被 [`service.client.spec.ts:85-86`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/tests/service.client.spec.ts#L85-L86) 固定）：

```ts
service.selectPanel(null)
expect(navigation.aborted).toBe(true)
```

---

## 问题：谁顶掉了哪一次导航（缺陷已确证，触发源未知）
**解法：常驻探针，等它自然复现时抓栈。**

> 这一节缺的**不是缺陷的证据**，而是**触发它的那一次导航调用**。
> 失败本身被观测到三次（20 个孤儿会话、界面闪回、侧边栏无新行），且对应代码分支与契约均已确证——
> 缺的是"当时是谁把导航顶掉的"这一个事实。

```text
1. Web GUI 按 F12 → Console（确认上下文是 dsh-app://app/）
2. 粘贴 abort-probe.console.js，看到 'dsh probe installed'
3. 之后正常使用；一旦再遇到闪回，立刻执行：
     copy(__dshAbortDump())
```

**已排除的假设（均有运行时证据）**

| 假设 | 排除依据 |
|---|---|
| `replaceMain` 的 `selectPanel(null)` 自我取消 | 它的 abort 检查全部在 `selectPanel` 之前（[navigation.ts:404-434](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/src/client/navigation.ts#L404-L434)） |
| `/plugins/events` 失败 = 传输层断裂 | 该路由存在（返回 200）；`ERR_FAILED` 是 SSE 长连接轮换的噪音，与复现与否无关 |
| `/api/changes.summary?…` 404 = 接口故障 | 它是 `ui-deliverables` 的正常接口（缺 `sessionId` 时返回 400），404 表示该会话暂无变更摘要 |

**成功路径的对照证据**：在一次**未复现**的完整操作中（新建对话 → 选工作区 → 侧边栏正常出现新会话），
探针记录 **0 次 abort**。即失败路径成立的前提——导航信号被取消——在成功路径上不出现。

**现状**：触发条件为间歇性，且与长时间运行的进程状态相关（重载页面后不再复现）。
因此以常驻探针等待复现，**不将其写成确定性根因**。


---

## 问题：怎么防止再犯
**解法：两处必修 + 一处待定。**

**必修（与触发条件无关，缺陷本身已确认）**

1. **已创建的会话不得静默丢弃** —— `navigation.aborted` 分支应保留引用或明确回收，而不是直接 `return`
2. **失败必须可见** —— `onPick` 的 `.catch` 需 `console.warn`，并在非中止场景发出 `createFailed` 通知

**待定（等常驻探针抓到触发栈再定）**

3. **揭幕不得取消自己的导航** —— 若确认触发源是面板切换，则 `replaceMain` 的 `selectPanel(null)` 不应 abort 调用方正在用的信号

回归测试已写入本地检出（**未运行**：本机无 `node_modules`）：

```
packages/client/ui-workspace/tests/workspaces-service.client.spec.ts:1112
  it.each(['panel', 'workspace'])('silently drops a created Session when a %s navigation supersedes the pick during acquisition')
  it.todo('keeps or recycles the created Session when a later navigation supersedes its reveal')
```

---

## 状态与来源

| 项 | 状态 |
|---|---|
| 探针自测 | ✅ 13/13 |
| 交付物校验 | ✅ 16/16（TypeScript 语法项 SKIP，需 `pnpm install`） |
| 回归测试 | 已写入，未运行（本机无 `node_modules`） |
| 触发条件 | **间歇性，未稳定复现**（重载后不再出现）；成功路径实测 0 次 abort |

- 上游仓库 `master` @ [`5badb15`](https://github.com/deepseek-ai/deepseek-harness/commit/5badb15009)，历史 20,736 提交
- 关键提交：[`c7e6e36dd`](https://github.com/deepseek-ai/deepseek-harness/commit/c7e6e36dd)（让被顶掉的创建通知保持静默）、[`93ad804bf`](https://github.com/deepseek-ai/deepseek-harness/commit/93ad804bf)（把被拒绝的创建上报为通知）
- 诊断初期提取的 `.dsh-src/` 已删除，可用 `extract-asar.js` 重建
