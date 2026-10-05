# 提交信息

规则取自 workbuddy2api-panel 的 172 条非 Merge 提交（feat 65 / fix 62 / chore 17 / ci 9），
scope 举例按本仓模块名替换，别照抄那边的 `panel`、`server`。

## 格式

`type(scope): 描述`

- type 小写：常用 `feat`、`fix`、`chore`、`ci`；`refactor`、`docs`、`test`、`style`、`ui`、`revert` 各 1~4 条
- scope 是本仓模块名（现在只有 `scripts`，Go 主程序建好目录后按目录名取）
- 22% 的提交不写 scope——跨模块或全局改动就不写，别硬凑
- 描述用中文，标题显示宽度中位 57 列，不以句号结尾
- 破坏性改动在 type 后加 `!`：
  `feat(server)!: 移除 server.max_body_mb 预拦截——大请求交由上游自然响应`

## 标题写什么

说清改了什么。不写「优化」「调整」「修复问题」这类看不出内容的词。

- 用 `——` 引出原因或后果，35/172 条这么写：
  `revert(videos): 撤回视频端点——上游 CN 无查询路由`
- 用 `（）` 标注来源，52/172 条这么写：
  `（移植上游 15a6fc9）`、`（合入上游 PR #70）`、`（issue #58）`
- 用 `+` 并列多件事，28/172 条这么写：
  `fix(server): 入站读取上限可配 + expiring_soon 文档对齐实现`
- 移植或同步外部改动时，把上游 hash / PR 号写进标题，不写空泛的「同步上游」

## 正文

88% 的提交有正文。正文写「为什么」和根因，不重复标题已经说过的内容。

- 多件事用 `- ` 列点，83/151 条有列点的正文
- 硬换行，行宽中位 69 列
- 不用 `Co-Authored-By`（180 条里只有 1 条），也不用 `BREAKING CHANGE` footer，破坏性改动用 `!`

## 反例

历史里出现过，不要跟：

- `Merge pull request #44 from piaopiao1997/...` —— 合并提交
- `修正券码兑换的提示文字` —— 没有 type
- `docs+fix: 快速开始重排（三种部署方式）+ 修 Docker bind mount 陷阱` —— 复合 type，拆成两条
- `fix: save config on Docker bind mounts` —— 本仓提交用中文，纯英文只占 8/172
