# Bug 报告草稿（用于 GitHub Discussions）

> 本仓库不接受外部 PR（`CONTRIBUTING.md` 明写），所以这份报告发到
> https://github.com/deepseek-ai/deepseek-harness/discussions → New discussion → 分类选 **Bug**（没有就选 General，标题前加 `[Bug]`）。
> 下方横线以内的内容可整段粘贴。

---

**标题**：`[Bug] Hero workspace pick silently drops an already-created session; the Host accumulates blank sessions (Web/desktop)`

**环境**
- DSH `0.2.0-rc.2`（Windows 桌面版，默认 profile）
- 代码引用基于 `master` @ `5badb15`；`0.2.0-rc.2` 的客户端 bundle 已实测含有相同分支

**现象**
1. 点「新建对话」
2. 在 hero 的工作区选择器里选任一工作区
3. 界面立即退回"选择工作区"的空白页；侧边栏**不出现**新会话；控制台**无任何输出**
4. 反复点击不会恢复，每次点击都会在 Host 留下一个空白会话

**落盘证据**
- `~/.dsh/storages/workspace.json`：70 秒内累积 20 个空白会话（APPO 16 个、default-workspace 7 个中的 4 个）
- 判据（取投影缓存，不是会话日志）：`sessionListMetadata.blank === true` 且无 title 且 `titleInput.count === 0`
- `~/.dsh/sessions/<workspace>/<id>/session.v4.jsonl.zstd` 存在，仅含 session 头
- 注：本版本该日志文件**连真实对话也只有一行会话头**，不能据其判空

**结论：创建成功了，是客户端丢弃了它**

`packages/client/ui-workspace/src/client/navigation.ts`（[L210-L223](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/src/client/navigation.ts#L210-L223)）

```ts
sessionId = await this.connectWorkspace(workspaceId)   // Host 已在此创建会话并登记进 Workspace
...
if (navigation.aborted) return      // ← 会话被丢弃：不 retain、不回收、不提示
this.replaceMain(sessionId, navigation, 'reveal', beforeOpen)
```

`packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx`（[L123-L129](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx#L123-L129)）

```ts
void selectWorkspace(workspaceId).catch(() => {     // ← 错误对象被丢弃，与包内 README 声明的 transient notice 契约不符
  setPendingWorkspaceId(current => current === workspaceId ? undefined : current)
})
```

因此失败既没有提示、也没有 console 输出；又因为**空白会话只在被选中时显示**，侧边栏同样没有痕迹。

**"静默"目前是被测试固定的**（[`workspaces-service.client.spec.ts:501`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/tests/workspaces-service.client.spec.ts#L501)）

```ts
it.each(['disposal', 'a later navigation'])('keeps a creation refused after %s silent', async () => {
  expect(b.notify).not.toHaveBeenCalled()
})
```

**仍不确定的一点（需要维护者确认）**
本次投递**没有稳定复现**该时序，因此不能断言"是哪一次导航顶掉了哪一次选择"。已排除的假设：
"`replaceMain` 里的 `selectPanel(null)` 自我取消"——它的 abort 检查全部在 `selectPanel` 之前
（[navigation.ts:404-434](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/src/client/navigation.ts#L404-L434)）。
另外两条看起来可疑、但实测无关的现象也已排除：`/plugins/events` 的 `ERR_FAILED`（SSE 长连接轮换噪音）、
`/api/changes.summary?...` 的 404（该会话暂无变更摘要）。

**对照证据**：在一次未复现的完整操作中（新建对话 → 选工作区 → 侧边栏正常出现新会话），
`AbortController.prototype.abort` 探针记录 **0 次 abort**。即失败路径成立的前提——导航信号被取消——在成功路径上不出现。

**建议的修复方向**（前两条与触发条件无关，缺陷本身已确认）
1. `navigation.aborted` 分支对**已创建**的会话应保留引用或明确回收，而不是直接 `return`
2. `onPick` 的 `.catch` 应至少 `console.warn`，并在非中止场景发出 `createFailed` 通知
3. 若确认触发源是面板切换：`replaceMain` 的揭幕不应 abort 调用方正在使用的导航信号
   （`ui-layout` 的 `selectPanel` 会 abort，[service.ts L72-85](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/src/client/service.ts#L72-L85)）

**回归测试**（可直接取用）
`packages/client/ui-workspace/tests/workspaces-service.client.spec.ts`
```ts
it.each(['panel', 'workspace'] as const)(
  'silently drops a created Session when a %s navigation supersedes the pick during acquisition',
  async (kind) => {
    const created = Promise.withResolvers<SessionId>()
    const b = bench({
      workspaces: workspaceState([workspace('a'), workspace('b')]),
      sessions: sessionState(),
      configureSessions: (sessions) => { sessions.create.mockReturnValue(created.promise) },
    })
    const pending = b.uiWorkspace.openWorkspace(wid('a'))
    if (kind === 'panel') b.layout.selectPanel('other-panel' as MainPanelId)
    else void b.uiWorkspace.openWorkspace(wid('b'))
    created.resolve(sid('created-a'))
    await pending
    expect(b.sessions.retain).not.toHaveBeenCalled()   // 现状：会话存在但被丢弃
    expect(b.notify).not.toHaveBeenCalled()
  },
)
```

完整证据、可运行探针与清理工具见：https://github.com/Topject/dsh-pick-silent-drop
