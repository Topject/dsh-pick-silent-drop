# 发布到 GitHub：操作步骤

当前机器的状态：**`gh` CLI 未安装**、**git 身份未配置**、`deepseek-ai/deepseek-harness` **不接受外部 PR**。
所以下面两步都需要你在已登录 GitHub 的浏览器里操作。全部命令可直接复制。

---

## 步骤 0：只做一次 —— 配置 git 身份

```powershell
git config --global user.name  "你的GitHub用户名"
git config --global user.email "你的GitHub注册邮箱"
```

---

## 步骤 1：发布诊断仓库（推荐先做）

**1.1 在浏览器创建空仓库**
打开 https://github.com/new ，填写：
- Repository name：`dsh-pick-silent-drop`
- 描述：`Diagnosis: DSH hero workspace pick silently drops an already-created session`
- 选 **Public**（要让讨论帖里的人能点开）
- **不要**勾选 README / .gitignore / license（本地已有文件，勾了会冲突）

**1.2 本地初始化并推送**

```powershell
cd '<本目录的绝对路径>'   # 例如 …\default-workspace\dsh-pick-silent-drop
git init -b main
git add -A
git status --short                      # 应恰好 9 个文件
git commit -m "Diagnose: hero workspace pick silently drops an already-created session"
git log -1 --format='author=%an <%ae>'  # ★ 必须是 232572035+Topject@users.noreply.github.com
git remote add origin https://github.com/Topject/dsh-pick-silent-drop.git
git push -u origin main
```

推送时会弹出 GitHub 登录窗口（或要求 Personal Access Token）。
若提示 `dsh-upstream` 之类路径被跟踪：确认 `git status` 里只有本目录的 9 个文件。

**1.3 确认渲染正常**
打开仓库首页，检查：
- README 的**章节导航锚点可点击跳转**（GitHub 支持中文锚点）
- 代码引用链接指向 `deepseek-ai/deepseek-harness` 且行号正确

---

## 步骤 2：发 Bug 报告到官方 Discussions

**2.1 打开** https://github.com/deepseek-ai/deepseek-harness/discussions → **New discussion**
**2.2 分类**：选 **Bug**（若无该分类，选 General 并保留标题里的 `[Bug]` 前缀）
**2.3 标题与正文**：直接复制 `DISCUSSIONS-POST.md` 中横线以下的内容
**2.4 收尾**：报告文末已写实仓库地址（`https://github.com/Topject/dsh-pick-silent-drop`）；若你用了别的仓库名，改掉那一行再发

---

## 步骤 3（可选）：把复盘长文发到自己的地方

排查叙事（无从下手 → 为什么无痕 → 触发点在哪 → 谁干的 → 怎么防）就是天然的博客结构。
`README.md` 的五个"问题"小标题可直接当章节骨架；`DISCUSSIONS-POST.md` 是精简版，适合发帖不适合长文。

---

## 注意事项

| 事项 | 说明 |
|---|---|
| 不要提 PR | 仓库当前不接受外部 PR，提了会被关 |
| 探针输出 | 第 4 节的"待确证"目前仍是空白；跑一次探针后补进 README，报告才完整 |
| 版本差异 | 本机 `0.2.0-rc.2`、源码 `0.2.1-alpha.1`，README 已声明，避免被质疑 |
| 如仍未安装 gh | 步骤 1 用 https 推送即可（`gh` 不是必需） |
