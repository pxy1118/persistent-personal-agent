# Persistent Personal Agent

拥有独立中文终端界面的本地个人助手。PPA 提供聊天、会话、人格/记忆编辑、模型配置切换和工具审批；Letta 在后台管理 Agent 执行与持久状态。默认界面显示 PPA 和助手自己的名字，不再启动 Letta 的终端界面。

## 启动

要求 Node.js 24.11.1 或更高的 24.x、npm、Git，以及已启动且支持 Chat Completions 和工具调用的本地模型服务。

```powershell
npm ci
npm run migrate:letta   # 首次初始化或从旧 PPA 迁移；重复执行不会覆盖已完成的导入
npm run doctor
npm start
```

也可双击 `start.cmd`，仍通过 `start.ps1` 和 `npm start` 启动 PPA 终端。默认复用已有固定 Agent 和会话，不重新导入人格，不登录云端，不自动启动、停止或更改模型服务。模型离线时仍可打开终端查看和编辑记忆，聊天会提示先启动模型并 `/reconnect`。`npm run start:letta` 保留为显式使用原生终端的维护入口。

PPA 在运行期间启动一个受认证保护、仅监听本机随机端口的后台子进程，通过官方 App Server 接口交互；退出时关闭它，不安装系统服务、不提供网页、不创建常驻任务。后台输出写入 `.ppa/ppa-runtime.log`，不会混入聊天。

依赖固定为 `@letta-ai/letta-code@0.31.12`，不依赖全局安装，不修改上游或 node_modules。Letta 自身仍间接使用 pi-ai；本项目已移除 Pi Coding Agent 运行时和直接 Pi 依赖。

## 模型与数据

配置示例在 `config/local.example.json`，可用 `config/local.json` 覆盖：

```json
{
  "modelBaseUrl": "http://127.0.0.1:8080/v1",
  "modelId": null,
  "contextWindow": 32768,
  "maxTokens": 4096
}
```

`modelId: null` 在初始化或选择该模型配置时使用服务的首个模型，后续启动沿用已保存选择。终端 `/model` 列出项目配置，`/model ornith` 或 `/model qwen3.8` 在空闲时切换；人格、记忆和当前会话保留。contextWindow 必须与模型服务匹配，PPA 不调整服务端上下文。初始化使用对应 0.31.12 的本地状态适配器，运行中的编辑和切换通过原生接口完成；升级版本前须重新验证接口。

`PPA_MODEL_API_KEY` 是可选环境变量，不写进报告、记忆或仓库。Letta 自身将 provider 凭据保存在本机，文件未加密。远程 modelBaseUrl 会把上下文发送到该服务。

### 模型配置与切换

预置模型配置在 `config/models.example.json`，当前包含：

| 配置名 | 地址 | 模型 ID |
| --- | --- | --- |
| `qwen3.8` | `http://127.0.0.1:8080/v1` | 启动时取该服务返回的首个模型 |
| `ornith` | `http://127.0.0.1:8000/v1` | `Ornith-1.5` |

可以直接在 PPA 终端输入 `/model ornith`。若使用外部配置命令，先退出正在运行的 PPA 实例，再执行：

```powershell
npm run model -- list
npm run model -- current
npm run model -- use ornith
npm start
```

切回 8080 模型：

```powershell
npm run model -- use qwen3.8
npm start
```

切换命令会先请求目标服务的 `/v1/models`，确认模型可用后才更新固定 Agent、provider 和 `config/local.json`。`qwen3.8` 配置的 `modelId: null` 会使用该服务返回的首个模型，并把实际 ID 写入活动配置。若在 Windows 中访问不到 WSL 的 `127.0.0.1:8000`，将配置中的地址改为 `wsl.exe hostname -I` 返回的 WSL 地址。`config/models.json` 可作为未提交的本机配置覆盖示例配置。

`PPA_DATA_DIR` 默认是项目的 `.ppa`：

| 位置 | 内容 |
| --- | --- |
| `letta/` | 原生 Agent、会话、provider 和 MemFS 状态 |
| `letta/memfs/<Agent ID>/memory/system/` | 原生人格及用户记忆 |
| `letta-migration.json` | 旧/新 ID 对应关系、来源指纹、导入清单和完成状态 |
| `letta-config.json` | 本数据目录的模型配置 |
| `ppa-terminal.json` | PPA 界面最近打开的 Agent 和会话，随备份保留 |
| `ppa-runtime.log` | 后台诊断日志，不属于聊天正文 |
| `workspace/` | 默认工作目录及项目会话设置 |
| `backups/` | 旧系统快照及新系统备份 |
| `reports/` | 本机验收报告 |

设置 LETTA_LOCAL_BACKEND_DIR 隔离原生 Agent/provider 状态。Letta 的部分界面偏好仍使用用户级 `~/.letta/settings.json`；本地会话选择记录在工作区 `.letta/settings.local.json`。请通过本项目入口管理同一数据目录，直接运行原生 CLI 的进程不受 PPA 实例锁约束。

## 日常使用与行为边界

直接自然聊天，Enter 发送。PPA 不在回复过程中排队新的聊天输入，Escape 或 `/stop` 中断当前回复；已发生的副作用不会撤销，中断内容不会自动重发。`/quit`、`exit` 或空闲时 Ctrl+C 正常退出。

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看 PPA 中文命令 |
| `/new` | 新对话，保留人格和记忆 |
| `/sessions` / `/resume 序号` | 列出和恢复当前助手的会话，包含原终端初始对话 |
| `/history` | 查看最近 20 条完整对话；启动时仅预览最近 6 条 |
| `/persona` / `/persona edit` | 查看和编辑人格正文 |
| `/memory` / `/memory 序号` | 列出原生记忆文件、查看内容 |
| `/memory edit 序号` | 编辑指定记忆正文 |
| `/model` / `/model 配置名` | 查看并切换项目模型配置 |
| `/reconnect` | 模型服务恢复后重新连接 |
| `/status` | 查看助手、模型、会话和工作目录 |

编辑时输入完整的新正文，单独一行 `.save` 保存并生成原生 Git 版本记录，`.cancel` 放弃；文件描述等元数据会保留。保存前核对原文版本，避免覆盖期间发生的记忆更新。工具需要审批时显示名称与参数，输入 `y` 只允许本次、`n` 拒绝，不追加长期授权。

独立 reasoning 通道只显示思考状态，不打印内容。**当前 Ornith/vLLM 有时把英文思考直接作为普通正文返回**，没有可识别的通道或标记时，界面无法可靠区分它与正常回答；本次真实验收已观察到此情况。PPA 不通过删除英文句子的方式隐藏它，历史中也可能保留这种普通正文。

默认使用 `standard` 审批模式，不继承旧 PPA 授权。启用 bundled/agent 技能；不自动加载旧扩展、全局技能或全局 Mods。旧 memoryBudgetChars、reflectionMaxTokens、reflectionTimeoutMs、extensions、skills 配置不再生效，会给出提示。此次不配置后台反思、常驻服务、定时任务、消息渠道或云端。

人格、记忆和会话已经交给 Letta，旧 PPA 的候选审核、忘记隔离、执行账本及自定义 reflect 节奏已移除。**删除当前记忆不等于删除聊天历史或 MemFS 的 Git 历史**，旧事实仍可能通过历史检索找到。工具权限采用 Letta 原生行为，不是操作系统沙箱；取消不会撤销已发生的副作用。

仓库 `config/identity.json` 只用于没有旧数据库时的首次初始化，启动或重复迁移不会覆盖后续学习。已有旧数据库时，从数据库的最新人格版本迁移。

## 迁移与回退

2026-09-06 已将本机最新人格与 **6 条有效全局记忆**迁入 Letta，默认入口已切换。旧数据库、会话与代码快照保留，未导入旧聊天、证据、历史版本、撤回内容、候选、授权、执行记录或测试 Agent。

迁移是确定性字段映射，不调用模型总结旧资料。首次写入前保存一致性 SQLite 快照、会话、配置和 HEAD 代码 ZIP；记录来源指纹及导入标签，失败保持 preparing。重复执行按标签恢复未完成目标；完成后只验证已有 Agent，不重新写入人格或记忆。来源在未完成迁移期间改变会停止，避免混合两份导入。Letta 使用自己的 Agent ID，旧 ID 只保留为迁移来源标识。

回退时，将迁移前备份的 `code.zip` 解压到独立目录，把该备份的 `ppa.sqlite` 和 `sessions` 放入其 `.ppa`，恢复所需配置，运行 `npm ci` 后启动。新 Letta 数据不要反向导入旧 SQLite。迁移前代码版本为 `07d2f7800c38bb9a887c6540a2fcd82897ee15c0`；具体备份目录记录在迁移清单中。

## 备份恢复

先退出使用本数据目录的所有 Letta 实例：

```powershell
npm run backup
npm run restore -- '<备份目录>' '<不存在的新数据目录>'
$env:PPA_DATA_DIR = '<新的数据目录>'
npm start
```

新备份包含完整 Letta 本地状态、工作区、项目会话设置和 PPA 模型配置，带 SHA-256 清单。恢复前校验所有列出的文件，拒绝损坏或越界路径，只写入不存在的新目录，并重映射项目会话设置中的本地存储位置。对话正文中的旧绝对路径不会被改写。

备份不导出 provider 凭据、不包含用户级界面偏好；恢复后需重新提供凭据。文件及历史内容未加密。新备份不会打包旧 PPA 数据库、旧会话、旧备份和验收用 Agent。

## 验证

```powershell
npm run build
npm test
npm run smoke:letta:integration  # 真实发布包 CLI + 本地模拟 HTTP/SSE
npm run smoke:live              # 真实本地模型；创建隔离测试数据
npm run smoke:interface         # PPA 交互层 + 真实原生后台 + 模拟模型
npm run smoke:terminal          # PPA 自有终端 + 当前真实模型，隔离验收身份
```

当前 11 项自动化测试通过；新增 PPA 接口的 11 项集成检查覆盖流式聊天、会话恢复、记忆提交和冲突保护、真实文件审批/拒绝、中断、模型切换及离线记忆访问。自有终端已在真实 Windows PTY 和 vLLM Ornith 上验证中文回复、人格编辑、键盘批准文件写入、Escape 中断及正常退出。迁移阶段的 Qwen 记忆、工具和备份恢复验收继续保留为历史证据。

本机报告位于 `.ppa/reports/letta-live.json`、`letta-integration.json`、`letta-pty.json` 和 `letta-migration-verification.json`。这些结果不保证长期陪伴体验或所有自然表达的记忆成功率；本地模型的工具选择和推理耗时仍会波动。

新界面报告在 `.ppa/reports/ppa-interface.json`、`ppa-tui-real.json`；验收身份和文件位于隔离目录，不写入正式助手。上游终端命令不会自动透传到 PPA 界面，其他高级原生功能仍可通过维护入口访问。

失败记录仍保留：Windows 文件授权通配规则未匹配曾导致工具被拒绝并超时，文件操作复测使用原生 acceptEdits 授权，正式入口仍为 standard。完全无输出的挂起模拟流曾未及时结束；已通过的流式中断测试不代表所有网络挂起情况。

固定发布包的 sharp <0.35.0 被 npm audit 报告高危公告 GHSA-f88m-g3jw-g9cj。未擅自降级 Letta 或修改其依赖实现，不将当前测试结果解释为依赖安全审计通过。
