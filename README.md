# Persistent Personal Agent

拥有独立中文终端和 Windows 桌宠界面的本地个人助手。PPA 提供聊天、会话、人格/记忆编辑、模型配置切换和工具审批；项目内维护的 PPA Runtime 管理 Agent 执行与持久状态。默认界面只显示 PPA 和助手自己的名字。

## 启动

要求 Node.js 24.11.1 或更高的 24.x、npm、Git，以及已启动且支持 Chat Completions 和工具调用的本地模型服务。

```powershell
npm ci
npm run migrate:ppa     # 首次初始化或从旧 PPA 迁移；重复执行不会覆盖已完成的导入
npm run doctor
npm start
```

也可双击 `start.cmd`，仍通过 `start.ps1` 和 `npm start` 启动 PPA 终端。默认复用已有固定 Agent 和会话，不重新导入人格，不登录云端，不自动启动、停止或更改模型服务。模型离线时仍可打开终端查看和编辑记忆，聊天会提示先启动模型并 `/reconnect`。`npm run runtime` 是底层维护入口；旧的 `migrate:letta`、`start:letta`、`doctor:letta`、`backup:letta` 和 `restore:letta` 仅作为兼容别名保留。

PPA 在运行期间启动一个受认证保护、仅监听本机随机端口的后台子进程，通过官方 App Server 接口交互；退出时关闭它，不安装系统服务、不提供网页、不创建常驻任务。后台输出写入 `.ppa/ppa-runtime.log`，不会混入聊天。

后台依赖已接管为仓库内的 `@ppa/runtime@0.31.12-ppa.1`，源码位于 `packages/ppa-runtime`，基于 Letta Code `v0.31.12` 的提交 `787b856f9db9f5030dc2976618e1d1f909f61612`。许可证、来源记录和原始文档均随包保留；间接的 Letta 客户端兼容依赖及旧存储字段本阶段不改名。

## 桌宠日常接口

首次安装需要 Python 3.10 或更新版本（64 位），使用项目内独立虚拟环境：

```powershell
powershell -ExecutionPolicy Bypass -File desktop-pet/setup.ps1
npm run pet
```

本机依赖已安装，也可以双击根目录的 **`启动桌宠.vbs`**，无控制台窗口启动。桌宠读取 `nuonuo_dev_assets` 的原始图片和声音；素材目录需要随项目保留。原参考项目 `D:\Workplace\pet\nuonuo_python` 不参与启动，也没有被修改。

- **单击角色**只在角色旁打开一行输入气泡，Enter 发送后自动收起；回复会流式显示在角色头顶，不弹出完整聊天窗口。头顶气泡最多展示约 300 字，较长回复保留开头和结尾，完整内容仍在会话历史中。
- 左键拖动和快速松手可以抛掷；右键可选择“快速说句话”“打开完整聊天”、喂点心、抱抱鼠标、跳跃、睡觉及唤醒。托盘双击唤回角色并打开完整聊天。
- 聊天支持中文流式回复、图片、停止、历史会话、新对话、人格与记忆编辑、模型和权限模式。Enter 发送，Shift+Enter 换行；Escape 在生成时停止，空闲时收起窗口。
- “睡觉”“醒醒”“回来”“回家”“跳一下”“翻个滚”“抱抱”“吃点心”是完整匹配的本地动作指令，其他输入交给当前助手。模型回复不会被当作桌面操作命令执行。
- 审批面板显示工具与完整参数，“允许本次”和“拒绝”沿用 PPA 原生权限。首次使用默认为标准审批；思考期间仍可切换权限，所选模式会在会话切换和重启后保留。
- 角色沿窗口边缘自主行走、攀爬、滑落，保留原动画的时序及睡眠过渡。聊天打开或后台忙碌时减少走动；拖拽、下落等物理状态优先。审批和错误气泡不会被闲聊覆盖。
- 右键设置可调整大小、素材声音、专注模式和主动搭话。主动短句在本地触发，至少间隔 45 分钟、每日最多 6 次；忙碌、专注、审批、睡眠及离开电脑时暂停。不会定时调用模型。

桌宠本身只使用鼠标位置、窗口几何和系统空闲时间，不读取窗口标题、桌面文件名，也不监听删除。助手只在用户要求查看屏幕或当前任务明确需要可见内容时调用受限读屏工具，不做周期截图。图片也可以通过用户选取的附件发送；虚拟点心不涉及真实文件。第一版没有语音识别、回复朗读或开机自启。

桌宠沿用现有 Agent ID、人格、记忆、模型和会话；`npm start` 的终端入口仍保留。同一数据目录只有一个 PPA 后台，使用桌宠前请退出终端；重复启动桌宠会唤起已有窗口。关闭聊天面板只是收起，右键“退出桌宠”才会停止所属后台。模型离线时仍可运行桌宠、访问可用记忆并手动重连，输入不会自动重发。

`PPA_DATA_DIR` 的默认值仍为 `.ppa`。桌宠自己的配置、位置、生活状态、主动次数和日志位于其 `pet/` 子目录，和助手长期记忆分开；PPA 备份会包含这些状态，旧备份缺少它们时使用默认值。备份前关闭桌宠。调试入口可指定 `--data-dir`，例如 `npm run pet -- --data-dir .ppa/pet-demo --no-backend`（仅动画演示）。

实现位于 `desktop-pet/`，Python `QProcess` 通过 JSON 行协议调用 `src/pet-bridge.ts`，由桥接层复用 `PpaSession`。Qt 不等待模型，图片预加载、状态合并队列和后台存档保持动画响应。PPA Runtime 在异步权限和记忆清理完成后才发送 `turn_finished`，因此正常跨回合直接复用当前后台。若停止请求未能结束挂起流，仍会关闭所属子进程后恢复同一会话，不重发输入。停止不撤销已经完成的工具操作。

桌宠验证命令：

```powershell
npm run build
npm test
npm run test:pet
npm run smoke:pet         # 隔离数据、真实后台、可控模型响应
npm run smoke:pet:live    # 隔离身份、当前真实模型：聊天/图片/审批/记忆恢复
npm run smoke:pet:gui     # 在上一条创建的隔离身份中操作实际 Qt 窗口
```

本机验收报告位于 `.ppa/reports/pet-*.json`，不写入正式助手。已完成真实 Qt 窗口中文输入、流式回复、图片、按钮审批后的文件写入和停止；中文输入法提交事件通过自动化模拟验证，未覆盖各输入法的候选窗操作。30 分钟桌宠运行记录约 11.25 万次更新，无界面/音频错误，帧间隔中位数 16.0 ms、P95 16.8 ms；预热后工作集约 243–251 MiB，CPU 时间折合单核约 6.5%。此数据针对本机单屏，混合 DPI 多屏只有合成物理测试，尚未实机验证。

## 模型与数据

配置示例在 `config/local.example.json`，可用 `config/local.json` 覆盖：

```json
{
  "modelBaseUrl": "http://127.0.0.1:8080/v1",
  "modelId": null,
  "contextWindow": 32768,
  "maxTokens": 4096,
  "provider": "llama-cpp"
}
```

`provider` 默认 `openai-compatible`，目前还支持 `llama-cpp`。PPA Runtime 会逐模型合并原生 `/models` 与 `/props?model=<id>` 的能力信息：已有上下文元数据但缺少模态声明时，仍补查视觉能力；明确的逐模型元数据保持优先，避免模型之间发生能力串用。PPA 现在直接连接配置的原始模型地址，不再启动本地模型代理。

`modelId: null` 在初始化或选择该模型配置时使用服务的首个模型，后续启动沿用已保存选择。终端 `/model` 列出项目配置，`/model ornith` 或 `/model qwen3.8` 在空闲时切换；人格、记忆和当前会话保留。contextWindow 必须与模型服务匹配，PPA 不调整服务端上下文。初始化使用对应 0.31.12 的本地状态适配器，运行中的编辑和切换通过原生接口完成；升级版本前须重新验证接口。

`PPA_MODEL_API_KEY` 是未指定独立凭据变量时的兼容环境变量。在线配置应使用 `apiKeyEnv` 指向自己的环境变量；配置文件只保存变量名，不保存密钥。Letta 连接 provider 时会在本机保存实际凭据，其文件未加密且不进入 PPA 备份。远程 `modelBaseUrl` 会把对话上下文、工具结果和你主动发送的图片交给该服务，请按其隐私政策选择服务。

### 模型配置与切换

预置模型配置在 `config/models.example.json`，当前包含：

| 配置名 | 地址 | 模型 ID | 提供方 |
| --- | --- | --- | --- |
| `qwen3.8` | `http://127.0.0.1:8080/v1` | 启动时取该服务返回的首个模型 | `llama-cpp`（llama.cpp，支持多模态） |
| `ornith` | `http://127.0.0.1:8000/v1` | `Ornith-1.5` | `openai-compatible`（vLLM） |

添加任意提供 `/v1/models` 与 `/v1/chat/completions` 的在线 OpenAI-compatible API（密钥不会写入 JSON）：

```powershell
$env:MY_LLM_API_KEY = "在这里填写密钥"
npm run model -- add cloud --base-url "https://你的服务地址/v1" --model "服务返回的模型ID" --api-key-env MY_LLM_API_KEY --context-window 32768 --max-tokens 4096
npm run model -- use cloud
npm run doctor
npm start
```

`add` 只写入被 `.gitignore` 排除的 `config/models.json`，不会立即改变当前助手；`use` 才会验证凭据和 `/models`、切换固定 Agent 的模型并更新 `config/local.json`。远程地址通过此命令添加时必须使用 HTTPS。以后启动 PPA 前仍需让同名环境变量存在；如需跨 PowerShell 会话保存，请使用系统的安全凭据管理方式注入，而不要把 Key 写进仓库、命令参数或 JSON。

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

直接自然聊天，Enter 发送。PPA 不在回复过程中排队新的聊天输入，Escape 或 `/stop` 中断当前回复；已发生的副作用不会撤销，中断内容不会自动重发。`/quit`、`exit` 或空闲时 Ctrl+C 正常退出；记忆编辑有未保存内容时 Ctrl+C 会先询问。

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
| `/mode` / `/mode 模式名` | 查看并切换权限模式；输入框直接按 Tab / Shift+Tab 循环切换（同 Claude Code） |
| `/image 路径` / `/image "路径" 问题` | 发送图片给助手（需模型支持视觉） |
| `/reconnect` | 模型服务恢复后重新连接 |
| `/status` | 查看助手、模型、会话和工作目录 |

编辑时输入完整的新正文，Ctrl+S 保存并生成原生 Git 版本记录，Esc 放弃；文件描述等元数据会保留。保存前核对原文版本，避免覆盖期间发生的记忆更新；有未保存修改时按 Ctrl+C 会先确认是否放弃修改并退出（y 确认 / n 或 Esc 返回）。工具需要审批时显示名称与参数，输入 `y` 只允许本次、`n` 拒绝，不追加长期授权。

权限模式（首次使用默认为标准审批，不继承旧 PPA 授权）：`/mode` 列出并切换；像 Claude Code 一样，聊天输入框直接按 **Tab** 向后循环、**Shift+Tab** 向前循环（有 `/` 补全项时 Tab 仍优先补全），模型思考期间也可以切换，底栏实时显示当前模式。`standard` 常规逐次确认；`acceptEdits` 自动批准文件写入/编辑/记忆（其余仍需确认）；`unrestricted` 全部工具免确认（谨慎使用）；`strict` 更保守、无自动放行。所选模式保存在当前 PPA 数据目录，并在会话切换、后台重连和应用重启后继续使用。

多模态：输入 `/image "图片路径" [问题]` 把图片随消息发给助手；含空格的路径用引号。支持 PNG/JPG/JPEG/GIF/WebP/BMP/HEIC/HEIF，单张不超过 20MB。图片作为用户消息的一部分走原生多模态通道，不经工具链；是否真正送达取决于模型服务声明的视觉能力。若后端无法处理图片，该回合自动降级为纯文本（不报错、不重发）。图片会以 base64 发送到配置的模型服务，并进入该会话的本地历史。

读屏工具：当你让助手“看看我的屏幕”或当前问题明确需要屏幕内容时，助手可以调用 `capture_screen` 读取主屏幕（也可选择全部显示器）。这是 PPA 内置的受限本机工具，不再为每次读取弹出审批；它只接受显示器范围和缩放上限，不提供任意命令入口。PPA 不生成独立截图文件，图像作为工具结果发送给当前模型，并可能保留在本机 Letta 会话历史中；远程 `modelBaseUrl` 会把图像发送到对应服务。该能力目前仅支持 Windows，并要求后端模型具备视觉能力。

独立 reasoning 通道只显示思考状态，不打印内容。**当前 Ornith/vLLM 有时把英文思考直接作为普通正文返回**，没有可识别的通道或标记时，界面无法可靠区分它与正常回答；本次真实验收已观察到此情况。PPA 不通过删除英文句子的方式隐藏它，历史中也可能保留这种普通正文。

首次启动使用 `standard` 审批模式，不继承旧 PPA 授权；此后使用当前数据目录中保存的选择。启用 bundled/agent 技能；不自动加载旧扩展、全局技能或全局 Mods。旧 memoryBudgetChars、reflectionMaxTokens、reflectionTimeoutMs、extensions、skills 配置不再生效，会给出提示。此次不配置后台反思、常驻服务、定时任务、消息渠道或云端。

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
npm run runtime:build        # 构建仓库内的 @ppa/runtime
npm run runtime:test         # 视觉发现与回合结束顺序的底层回归
npm run runtime:pack         # 生成可审查的 @ppa/runtime 包
npm run build
npm test
npm run smoke:letta:integration  # 兼容别名：PPA Runtime CLI + 本地模拟 HTTP/SSE
npm run smoke:live              # 真实本地模型；创建隔离测试数据
npm run smoke:interface         # PPA 交互层 + 真实原生后台 + 模拟模型（含批准后真实读屏）
npm run smoke:terminal          # PPA 自有终端 + 当前真实模型，隔离验收身份
npm run smoke:image             # 真实模型多模态：发图并核对模型回答内容
npm run smoke:screen            # 实际截取当前主屏并验证 PNG 工具结果
```

本轮验收通过：根项目测试 36 项、PPA Runtime 聚焦回归 14 项、品牌及本地后端相关回归 85 项、真实 Qwen 核心检查 20 项、桌宠 Python 测试 32 项、PPA 接口集成 15 项和桌宠烟雾检查 16 项；从不含 `node_modules`、构建产物和已生成技能的全新目录执行 `npm ci`，随后构建及两组测试均通过。PPA 接口集成覆盖流式聊天、会话恢复、图片消息、读屏工具结果、记忆提交和冲突保护、文件审批/拒绝、思考期间权限模式切换及重启保留、中断、模型切换和离线记忆访问。

本机报告位于 `.ppa/reports/letta-live.json`、`letta-integration.json`、`letta-pty.json` 和 `letta-migration-verification.json`。这些结果不保证长期陪伴体验或所有自然表达的记忆成功率；本地模型的工具选择和推理耗时仍会波动。

新界面报告在 `.ppa/reports/ppa-interface.json`、`ppa-tui-mock.json`、`ppa-image.json`，真实核心报告在 `.ppa/reports/letta-live.json`。本轮 Windows PTY 验证了连续聊天、文件批准与真实写入、流式中断以及安全退出；中断事件为 `cancelled`，输入未自动重发。本机 Qwen/llama.cpp 原始模型地址完成了文本和真实图片识别，模型正确识别验收图中的红环、蓝点和蓝色 PPA 字样；真实核心检查还覆盖人格与记忆召回、跨会话记忆增删改、文件与命令工具、严格拒绝、备份恢复以及恢复后 Agent ID/记忆关联。Ornith 的 `127.0.0.1:8000` 服务本轮未运行，因此没有把其历史结果计入本轮自有运行时验收。验收身份和文件位于隔离目录，不写入正式助手。上游终端命令不会自动透传到 PPA 界面，其他高级原生功能仍可通过维护入口访问。

失败记录仍保留：Windows 文件授权通配规则未匹配曾导致工具被拒绝并超时，文件操作复测使用原生 acceptEdits 授权，正式入口仍为 standard。完全无输出的挂起模拟流曾未及时结束；已通过的流式中断测试不代表所有网络挂起情况。

当前依赖树仍有一项 npm high severity 报告：运行时继承的 `sharp < 0.35.0`，npm 建议的 `0.35.4` 属于主版本升级，本次没有静默套用。运行时功能测试不等同于依赖安全审计通过。
