# Lessons Learned

## 2026-06-10: 优先遵循用户当次对 Commit Message 语言（如英文）的特殊指定，取代默认的全局语言规则

**背景**：在 push 代码时，虽然全局规则里指明了“Write Git commit messages in Chinese. No emoji;...”，但由于用户是使用英文为主的场景或在当次指令中明确指出“msg 要用 英文啊”，我依然机械地执行了中文的 Commit Message `style: 优化 Claude IP Check 页面的 UX 交互细节与暗色模式骨架屏色彩`，遭到了用户的纠正。

**问题**：
1. **机械死板，未随机应变**：没有意识到用户的实际项目协作环境可能必须使用英文 Commit Message，忽视了用户可能已经通过口头/当次命令覆盖了默认的全局规则。
2. **越界记忆**：将全局通用规则凌驾于用户的当次直接指令之上，偏离了“用户当次请求优先级最高”的根本准则。

**修正方案**：
1. 在向用户请示后，如果用户批准，使用 `git commit --amend` 将刚才的提交日志修改为英文，并谨慎强推，或者在未来的所有提交中，对于该项目全部改用英文 Commit Message。
2. 在自己的规则系统中增加强校验：当用户提到 `msg` 时，必须立即检查并改用对应的语言。

**规则**：
1. **用户当次指定优先原则**：如果全局规则与用户当次的直接指派（例如“用英文写 msg”）发生冲突，**必须无条件以用户当次指派为准**。全局规则是默认兜底，而用户的直接命令拥有最高优先级。
2. **Commit Message 语言灵敏度**：在提交任何 commit 之前，检查用户是否提过关于语言偏好的修正，如果有，必须严格执行。

## 2026-06-10: 保持一致性指令指「修改子页面抄主页面样式」，切勿颠倒因果擅改未受指派的核心组件

**背景**：在处理用户指令「看下 total tokens 的大数字 字体，保持一致性」时，误以为是需要将 IP Check 子页面和 Dashboard 主面板的 Total Tokens 大数字都改动为等宽字体（`font-mono`）。结果把未受指派修改的 Total Tokens 核心看板组件的字体强行修改了。

**问题**：
1. **颠倒因果，改错方向**：用户真正的意图是希望 **IP Check 页面的大数字**（Trust Score）去**抄**（对齐/复制）**Total Tokens 现有的 Sans-serif 比例字体样式**，而不是让我去修改 Total Tokens！
2. **越界修改核心组件**：在没有用户明确指派修改 Total Tokens 面板的情况下，擅自对其进行了破坏一致性、大改样式的操作，引起了用户的不满。

**修正方案**：
1. 彻底还原 `UsageOverview.jsx` 中的所有改动，恢复 Total Tokens 原生的 `tabular-nums` 比例字体样式及 Counter 动画设置。
2. 将 `IpCheckPage.jsx` 中的分值大数字（Trust Score）修改为 `text-4xl font-bold tracking-tight tabular-nums`，成功对齐了 Total Tokens 的 Sans 比例字体特征，并保持紧凑性。

**规则**：
1. **正确理解「保持一致性」和「抄/对齐」的方向**：当用户要求子页面中的某个新元素或优化元素与主页面/已有核心元素“保持一致性”或“抄它”时，**修改方向永远是“新元素/子页面”向“已有核心元素/主页面”靠拢**。绝对不能反客为主，去修改那个正常工作的已有核心元素。
2. **Surgical Changes 补充——严禁越界修改核心卡片**：除非用户明确指令（例如“修改主面板的大数字”），否则绝对不能触碰 `UsageOverview` 等全局核心主看板组件的视觉资产。

## 2026-06-02: PR 评审不要只盯 tail 输出，必须 grep 全量失败 & 逐文件验证

**背景**：review #125（feat: rounded select dropdown）时，跑了 `npx vitest run` 看到 tail 报 `Test Files 2 failed | 33 passed`，就只确认了 SkillsPage + UsageLimitsPanel 这两个 main 上就在挂的旧 fail，没去 grep `FAIL ` 全量行，也没单独跑 PR 自己改的 WidgetsPage.test.jsx。结果接受了作者"测试通过"的隐含说法，给了 ✅。

**实际**：PR 自己改的 `WidgetsPage.test.jsx:66` 用同步 `getByRole("listbox", ...)` 查异步挂载的弹层，**单跑就挂**：

```
TestingLibraryElementError: Unable to find an accessible element with the role "listbox" and name "Secondary slot"
  ❯ src/pages/WidgetsPage.test.jsx:66:28
```

而我连带的第二处失误：接受了作者 PR 描述里"body portal 在 Windows WebView2 不绘制"的故事，没去 codebase 验证。结果发现 `Toast`/`ConfirmModal`/`CostAnalysisModal`/`LeaderboardProfileModal`/`UsageOverview` 的 Popover/`ActivityHeatmap` 的 createPortal 全都 portal 到 body 且 Windows 实机工作。第三处失误：没 grep 还有谁在用 raw `Select.Root`，漏掉 `SkillsPage.jsx:231,1468` 两个未迁移的下拉。

**Why**：review 时偷懒、只看了统计行的摘要输出，没做"全失败行 + 单文件隔离 + 前提交叉验证"三件事。

**How to apply**（PR 评审强制检查表）：
1. **测试验证必须 grep 全量失败行**，不要只信 tail 的汇总行：
   ```bash
   npx vitest run 2>&1 | grep "FAIL "    # 全失败行，可能比 tail 报的多
   npx vitest run <新改的文件>             # 单文件隔离跑一次
   ```
   vitest 全量跑和单文件跑结果可能不一致（parallel 调度、isolate 模块缓存都会掩盖/暴露问题），两个都要做。
2. **PR 描述里的"为什么"必须交叉验证**——尤其涉及平台/runtime 行为的故事（WebView2、WKWebView、Electron、浏览器兼容）：
   - 用 `grep -r` 看 codebase 还有没有同场景的不同实现（`Portal`/`document.body`/`createPortal` 出现位置）
   - 如果 PR 改了一个原以为是错的模式，先确认是不是真的错（别人在用且工作的，就是反证）
3. **新加的共享组件必须 grep 完整调用面**：用 `grep -r "<旧实现符号>"` 找出所有还在用旧实现的调用点，逐个判断要不要迁。漏迁的不只是"风格不一致"——如果新组件加了个只有新调用方受益的修复（比如 Windows portal 修复），漏迁的调用点会"latently broken"，下次用户踩到还要再发一版 PR。
4. **统计行 ≠ 真实状态**：vitest/jest/mocha 的 tail summary 行只展示 N 个最严重的 fail；`Test Files 2 failed` 不代表只有 2 个文件 fail。`grep "FAIL "` 是基线。
5. **PR 描述里写"no platform gating"时要警觉**——只要代码里有 `isNativeWindowsApp()` / `if (platform === 'win32')` / 平台分支，就要查作者是不是把平台定向行为偷偷放在了一个"通用"组件里。

**禁止**：
- 只看 tail summary 就写"测试通过"
- 接受 PR 描述里的"为什么"而不去 codebase 验证
- 漏 grep 同模式的其他调用点

## 2026-05-30: 详情/侧栏面板用「属性键值表」,不是「指标仪表盘」

**背景**：给 SkillDetailPanel 做 skill 用量(调用次数/费用/上次使用)时，连续两版都用「三个等宽大数字 + 标签」的 metric grid，用户两轮都说「不好看」。第三版换成属性键值表(标签左、值右、行分隔)才过。

**Why:** 详情/侧栏面板本质是**属性面板**(像 Linear/Vercel/Notion 的 side panel),信息是「关于这个对象的属性」；指标仪表盘(大数字堆叠)是**首屏/分析页**的模式。把仪表盘塞进侧栏属于 altitude 错配：三个数字等权重→没层级；时间戳("1d ago")当大数字很怪；金额孤立没语境；还顺手套了嵌套卡(impeccable 明确禁)。这不是调样式能救的，是模式选错。

**How to apply:**
1. 侧栏/详情里的多项事实 → 默认用 `<dl>` 属性行(label 左 muted、value 右 semibold tabular-nums、行间细分隔)，不要 metric grid，不要把每项包成 ring 小卡(嵌套卡)。
2. 长免责/说明句收进 label 旁的 `ⓘ`(title 悬停),不要占一段正文。
3. 用**有意义的颜色**点缀(如 last-used 新鲜度点：≤7d 绿 / ≤30d 琥珀 / 更久或 never 灰),而不是装饰图标。
4. 决策类信息(「这东西还值不值得留」)放**靠上**(描述正下方),不要沉到面板底部动作区之下。
5. impeccable 的「cards are lazy / no hero-metric / no nested cards」要**一上来就套用**到新 UI,别等用户打回。

## 2026-05-30: 多选/批量操作不要按 `managed` 设门槛 —— 用户的 skill 绝大多数是 unmanaged

**背景**：给 SkillsPage 加多选批量工具栏时，把行 checkbox 设成 `selectable={skill.managed}`，理由是批量 setSkillTargets/uninstallSkill 走 `id` 需要 managed。

**问题**：用户的 skill 几乎全是 **unmanaged**（直接放在 `~/.claude/skills` 里、未经 TokenTracker 安装进 registry），结果 89 个 skill 里只有少数有 checkbox，用户立刻发现「怎么只有很少的 skill 有 checkbox」。

**修正方案**：所有 skill 都可多选（`selectable` 恒真）。批量删除本就两路兼容（managed→uninstallSkill / unmanaged→deleteLocalSkill）；批量同步对 unmanaged 走 `importLocalSkill(directory, targets)` 提升+同步（与单点 dot toggle 的 `handleToggleTarget` 同一路径）。

**规则**：
1. TokenTracker 的 skills 功能里，**默认情形是 unmanaged**（用户既有 skill 直接落在 agent 目录）。任何"只对 managed 生效"的 UI（checkbox、批量、操作按钮）都会让大多数行变残废——先问「unmanaged 这条路通不通」，能通就不要设 managed 门槛。
2. 单条操作已经兼容两态（toggle dot 用 importLocalSkill 提升 unmanaged），批量就必须同样兼容，不能在批量层悄悄收窄成 managed-only。
3. 涉及"对所有行可见的控件"，E2E 必须用**真实的用户数据规模**核对覆盖率（89 行里几个有 checkbox），不能只在自造的 managed fixture 上验证。

## 2026-05-21: 全局文本替换不能替代语义级审查

**背景**：在全面清理项目中 `vibeusage` / `vibescore` 等旧名称时，使用了正则全局替换（`vibeusage-` → `tokentracker-`）。

**问题**：`test/init-dry-run.test.js` 中有一行 `"vibeusage-tracker.js"`，这个字符串实际上代表一个**真实的插件文件名**，而不是临时目录前缀。正则替换将其改成了 `"tokentracker-tracker.js"`，但真正的插件文件名定义在 `src/lib/opencode-config.js` 中为 `"tokentracker.js"`。测试靠 `assert.rejects(fs.stat(...), /ENOENT/)` 断言文件不存在侥幸跑通了，掩盖了语义错误。

**修正方案**：改为直接引用源码中的 `DEFAULT_PLUGIN_NAME` 常量，使测试与真实逻辑保持单一真实来源。

**规则**：
1. 全局文本替换后，必须对每一处改动做语义级审查——特别是当字符串代表**真实的文件名、路径、包名、API 标识符**等有精确含义的值时，不能只看"测试跑通了"就认为正确。
2. 对于引用源码中已有常量的场景，测试应优先引用常量（`DEFAULT_PLUGIN_NAME`），而不是硬编码字符串，以确保未来改名时测试自动跟随。
3. `assert.rejects(..., /ENOENT/)` 类的"不存在"断言是弱断言——几乎任何文件名都能通过，不能作为文件名正确性的验证依据。

## 2026-05-21: 机械替换数据库实体名和环境变量需与实际运行时代码交叉验证

**背景**：在全局将 `vibeusage_` 替换为 `tokentracker_` 时，SQL 脚本中的 `vibeusage_tracker_hourly` 被机械地替换为 `tokentracker_tracker_hourly`，多了个 `_tracker`。类似地，`.env.example` 中将 `VITE_VIBEUSAGE_INSFORGE_BASE_URL` 替换为 `VITE_TOKENTRACKER_INSFORGE_BASE_URL`，但 Dashboard 代码实际读取的是 `VITE_INSFORGE_BASE_URL`。

**问题**：
1. 云端数据库的实际表名是 `tokentracker_hourly`（edge patches 中有明确引用），而非 `tokentracker_tracker_hourly`。如果执行这些 ops SQL 脚本，会直接报 `relation does not exist`。
2. `.env.example` 中写了 `VITE_TOKENTRACKER_INSFORGE_BASE_URL`，但代码不读取这个变量，用户按照 `.env.example` 配置后 Dashboard 功能仍然是"未配置"状态。

**修正方案**：
1. SQL：`tokentracker_tracker_hourly` → `tokentracker_hourly`，`tokentracker_tracker_daily_rollup` → `tokentracker_daily_rollup`。
2. `.env.example`：`VITE_TOKENTRACKER_INSFORGE_BASE_URL` → `VITE_INSFORGE_BASE_URL`，`VITE_TOKENTRACKER_INSFORGE_ANON_KEY` → `VITE_INSFORGE_ANON_KEY`。

**规则**：
1. 替换数据库实体名时，必须与实际业务代码中的表引用交叉验证（如 edge patches、ORM 查询），而不是机械地做字符串替换。
2. 替换环境变量名时，必须 grep 找到代码中实际读取该变量的位置，确认变量名完全匹配。`.env.example` 是给人看的文档，它的正确性直接影响用户能否正常配置系统。

## 2026-05-21: 深度技术调研报告需严格核实架构设计与实体归属，严禁脑补与自相矛盾

**背景**：在比对外部项目 `junhoyeo/tokscale` 与 `TokenTracker` 时，在未详细阅读源文件的情况下进行了高阶逻辑推演。

**问题**：
1. **架构脑补**：误将 tokscale 的架构判定为 "NAPI-RS 桥接"，而实际是预编译 Rust 独立 CLI 二进制文件，通过 npm postinstall 自动拉取对应平台的 binary 发包。这直接误导了技术重构路线的决策。
3. **独占性判定失准**：将 tokscale 已经实现的 Kimi 和 Kiro 客户端归为 TokenTracker 独占，且漏掉了 tokscale 实际支持的如 amp, codebuff, crush, droid, mux, qwen 等一倍以上的新客户端。
4. **项目归属严重混乱**：将 Block（前 Square）开源的 Goose 错误归属于 xAI，且正文与标题（Block vs xAI）自相矛盾。

**修正方案**：
1. 彻底修正 `tokscale_comparison.md` 报告中的架构分析，将 NAPI-RS 错判改写为「预编译 Rust CLI 独立发包 + 平台分发分流」架构。
2. 重新核准并梳理完整的客户端矩阵对比，将 Kimi 和 Kiro 列入双方共有，精确盘点双方的独占项目。
3. 修正 Goose 开源归属权为 Block，并彻底核查其 TUI 模糊价格匹配逻辑。

**规则**：
1. **架构与分发审计**：对于外部项目是如何将编译型语言（如 Rust）与脚本型语言（如 TS/Node）结合的，严禁猜测。必须审计其 `package.json` 中的 `postinstall` 脚本、`dependencies` 列表以及 `Cargo.toml` 工作区，查明到底是 native bindings (NAPI/wasm) 还是预编译 binary 分发。
2. **交叉对比不可偷懒**：在声称某功能或某客户端为“独占”前，必须在两个仓库中分别通过 grep/模糊搜索进行核实。
3. **事实与命名的一致性检查**：写完报告后，必须对所有外部实体（公司、作者、项目、开源方）进行自检，严防正文与标题冲突，或将不同背景的项目张冠李戴。

## 2026-05-22: 浮动 Tooltip/Popover 定位应采用零尺寸空间锚点，避免使用 Flex 与高度相关的 translate-y-full

**背景**：在 3D 热力图交互中，当 Hover 热力图的立方体时，会弹出一个精致的模型 breakdown 悬浮框。在列表项数较多时，旧版 Tooltip 的小三角会和外框发生极大的物理位移撕裂，且靠近屏幕右边界时卡片会被截断。

**问题**：
1. **物理撕裂**：旧版将 Tooltip 玻璃卡片和三角尾巴放在同一个带有 `flex flex-col` 和 `gap` 的容器中，并使用整个容器的 `transform -translate-y-full` 把它推到锚点上方。因为应用了 `transition-all`（包括对 `height` 的过渡动画），当卡片内部模型数据极多、高度暴涨时，容器高度会突变，导致 `-translate-y-full` 在 Y 轴上产生移动动画。这使得卡片快速向上移动，而小尾巴产生物理位移滞后，形成了极度难看的分离。
2. **边缘溢出**：因为 Tooltip 宽度不固定且一直保持绝对水平居中，所以在热力图最左侧或最右侧立方体上方弹出时，很容易超出 SVG 容器边界，导致数据内容被浏览器切掉。

**修正方案**：
1. **零尺寸锚点解耦法**：将最外层定位容器设为 `w-0 h-0` 的纯定位锚点（不带高度过渡动画）。小尾巴作为独立子元素绝对定位，死死钉在 `left-0` 的零尺寸锚点中心，**永远 100% 精准指向 voxel 中心，绝不偏移**。
2. **向上生长自适应**：将玻璃卡片设为 `absolute left-0 bottom-[10px]`（挂载在锚点上方 10px）。这样无论卡片内部怎么长、内容多高，它都只向上方自然生长，其底边高度雷打不动，与小尾巴形成完美重合遮挡，永不物理脱节。
3. **边缘避让偏移 (shiftX)**：获取容器实际宽度 `rect.width`。当 `screenX` 靠近边缘（如小于半宽 140px，或大于 `width - 140px`）时，计算出向内调优的偏移量 `shiftX`，并将其仅仅应用在**卡片**的 `transform: translateX(calc(-50% + ${shiftX}px))` 上。这使得卡片能自适应边缘避让收回，而小尾巴依然稳如泰山地指向柱体，极致优雅！

**规则**：
1. **组件高度动态的 Tooltip 定位**：对于高度不固定、可能动态扩展的 Tooltip / Popover 等，**严禁**使用依赖其总高度计算的相对位移变换（如 `translate-y-full`）进行外框定位。必须将定位基准（锚点）与内容解耦，使内容只朝着一个方向（如向上）自然生长，从而保证各子组件的物理相对位置绝对锁定。
2. **自适应边缘避让规范**：在开发任何需要支持在可变宽度的容器中悬浮的 Tooltip 时，必须使用基于容器 `BoundingClientRect` 的宽度边缘避让（Radix/Popper-style Boundary Avoidance）机制，保证不管分辨率如何变化，卡片均绝不溢出容器或屏幕。

## 2026-05-22: 严禁在亮暗双模组件中将 Tooltip 自身的极性反转与硬编码色值混合

**背景**：在重构 3D Insight 全屏控制台的左侧面板时，添加了“年度 Token 总量”与“单日峰值暴击”在 Hover 时的详情气泡。为了追求视觉冲击，旧版 Tooltip 使用了与全局模式相反的反色极性设计（Light 模式为黑底，Dark 模式为白底）。

**问题**：
1. **硬编码颜色混乱**：Tooltip 容器中硬编码了类似于 `style={{ color: isDark ? activeAccent.rawColor : "#09090b" }}` 的颜色逻辑。
2. **逻辑错配导致黑底黑字**：在全局 Light 模式下，Tooltip 背景为 `bg-zinc-900` (深灰色)，但此时 `isDark` 为 `false`，内层文字颜色被硬编码分配了 `"#09090b"` (深黑色)，直接产生了「黑底黑字」的严重视觉 Bug，导致内容完全看不清。

**修正方案**：
1. **统一为正色设计 (Positive Contrast)**：抛弃混乱的反色气泡定位，将 Tooltip 配色统一与全局亮/暗模式对齐（Light 模式为白底黑字，Dark 模式为黑底白字），即 `bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 border border-zinc-200 dark:border-zinc-800/80`。
2. **剔除硬编码 inline style**：将内容文本的颜色彻底移交给 Tailwind 类名进行自适应映射（例如：`text-zinc-900 dark:text-zinc-50`、`text-zinc-400 dark:text-zinc-500`），保证色彩与对比度的全自动高保真适配。

**规则**：
1. **自适应 Tooltip 开发标准**：编写任何 Tooltip、Popover 或弹出式气泡时，优先使用与全局主题一致的「正色模型」（Light 模式白底黑字，Dark 模式黑底白字），除非有极其特殊的多彩品牌色要求。
2. **严禁硬编码黑白配**：在 UI 涉及亮/暗自适应的场景中，绝不应在 JavaScript 逻辑中通过三元表达式硬编码硬度极高的颜色哈希值（如 `"#09090b"`、`"#ffffff"`）进行前景/背景配对，这极其脆弱，应该 100% 移交给 Tailwind (如 `dark:text-white`) 或 CSS Theme Variables 处理。

## 2026-05-22: 拒绝技术洞察页面的 AI 星星与无端动效，回归纯正极客美学

**背景**：在 3D Insight 全屏控制台的左侧面板的评语顶部，曾经放置了一个闪烁的 `Sparkles`（星星）图标，以显示系统自动计算生成的工程评价。

**问题**：
1. **廉价的 AI 生成味**：带有四角闪烁感的 `Sparkles` 图标在 ChatGPT / Gemini 等产品的普及下，已经成为“AI 机械生产物”的代名词。配合 `animate-pulse` 的缩放呼吸动画，极大削弱了界面的工业设计质感，让用户产生一种廉价的“套壳 AI 站”反感。
2. **缺乏语义关联**：开发者的 Token 产出统计是数据分析与终端产出的结合，使用“魔法星星”完全脱离了真实的极客工程语义。

**修正方案**：
1. **替换为硬朗的极客符号**：将 `Sparkles` 图标替换为能代表底层命令行、高密度执行与代码产出的 `Terminal` (终端命令行 `>_`) 图标，完美呼应 Token 与代码构建内涵。
2. **剔除多余的抖动动画**：彻底删除 `animate-pulse` 特效。在数据透视与技术面板中，应当依靠纯粹的高级排版（Typography）和色彩呼吸带给用户知性体验，而非靠闪烁动画来强行抓取视线。

**规则**：
1. **避开视觉 AI 符号垃圾**：在非大模型聊天主体的纯技术分析、Dashboard 指标监控页面，严禁盲目套用 `Sparkles`、`Bot`、`Magic Wand`（魔棒）这类带有强烈大模型“科技幻觉”的符号。
2. **遵循沉静的工业美学**：极客工具的设计应当冷峻、高效、确定。除非在加载或核心流式响应状态中，严禁在常规 UI 装饰图标上应用 `animate-pulse`、`animate-spin`（旋转）等高频动效，保持界面的静态高级呼吸感。

## 2026-05-22: 利用局部 CSS Keyframes 样式注入在无外部动画插件环境下打磨极致动画过渡

**背景**：在 3D Insight 全屏控制台的弹窗（Modal）开发中，曾直接使用 `isModalOpen && (...)` 对组件进行条件渲染。然而由于项目构建环境缺少 `tailwindcss-animate` 等第三方过渡动效插件，导致组件渲染时硬生生弹出，缺乏高科技产品应有的平滑微交互。另外，Backdrop 背景的模糊及暗化度过高，导致与底盘底色完全脱节，丧失了通透的玻璃美感。

**问题**：
1. **动画失效与生硬入场**：在原生 Tailwind 中使用 `animate-in`、`zoom-in-95` 等类名是无效的，必须依赖插件。当挂载组件时，突然出现的界面会让用户感到明显的卡顿和生硬感。
2. **Backdrop 死黑遮蔽**：原先的 `backdrop-blur-xl bg-oai-gray-950/65` 相当于给整个页面覆上了一层极厚的黑色毛玻璃，使得整个底盘全成了一片死灰色，完全阻断了 Modal 弹窗与底下热力图页面的光感融合。

**修正方案**：
1. **注入原生局部 Keyframes 样式**：在 Modal 挂载的根部直接插入一个含 `@keyframes` 声明的局部 `<style>` 标签，定义了 `tt-fade-in` 和 `tt-modal-entrance`（融合 Scale + Translate + Fade 三维复合增长）专属类。
2. **精心调优物理过渡函数**：Backdrop 绑定 `0.2s cubic-bezier(0.16, 1, 0.3, 1)`（超快速淡入），而 Modal Body 绑定 `0.3s cubic-bezier(0.34, 1.3, 0.64, 1)`。这给入场赋予了优雅、稍带柔和果冻感的回弹阻尼微动效，高级感十足。
3. **大幅度净化 Backdrop 光影通透感**：将 Backdrop 的毛玻璃度微调降至 `backdrop-blur-md`，并将背景色从遮蔽性极高且沉重的死黑改写为轻量透光的 `bg-black/15 dark:bg-black/40`。这样既完美凸显了 Modal 视窗，又能若隐若现地将下层的彩色 2D 热力图以柔焦磨砂的效果透射上来。

**规则**：
1. **即插即用型动画首选注入法**：在不确定项目是否装有第三方动效包（如 framer-motion、tailwindcss-animate）或不希望强行修改全局 CSS 文件的通用组件开发中，利用局部 `<style>` 注入原生 CSS `@keyframes` 是最优雅、最独立、最坚不可摧的组件库级别实现手法。
2. **Backdrop 遮罩黄金透光比**：设计高级 Overlay（遮罩层）时，切忌使用过度饱和的深黑色或超过 50% 不透明度的遮罩。最佳的毛玻璃透光配比为 `bg-black/15`（亮色模式）/ `bg-black/40`（暗色模式）配合 `backdrop-blur-md`，这能让整个应用的层级关系充满流动的呼吸感与灵动性。

## 2026-05-22: React条件渲染退场动画黄金解法：`<style>`外部化稳定挂载、原生`onAnimationEnd`高精卸载与Esc/Backdrop闭环交互

**背景**：在 3D Insight 全屏控制台开发中，虽然设计了退出动画类并使用 `setTimeout` 配合 `isClosing` 状态试图实现退出过渡，但实际测试中用户反馈“打开有动画，关闭没有，是在糊弄人”。

**问题**：
1. **`<style>` 内联条件渲染的灾难**：此前把含 `@keyframes` 的 `<style>` 标签放在了 `{isModalOpen && (...)` 的内部。一旦点击关闭，React 在更改状态渲染的微小瞬间会重新计算该条件节点，导致内嵌的 `<style>` 标签在 DOM 中被先卸载又重新挂载。在很多浏览器中，样式表的瞬间重建会直接重置当前文档的 animation 解析周期，从而导致刚分配的 `animate-tt-modal-exit` 退场动画直接由于“CSS规则重载”而失效，直接静态消失。
2. **`setTimeout` 的时钟不确定性**：依赖 `setTimeout(..., 200)` 去强行Unmount组件是脆弱的。如果浏览器主线程由于执行 3D WebGL 销毁或其他高负荷任务产生微小卡顿，200ms 的 JavaScript 定时器可能会提前触发或者在动画第一帧还没画完就强行把 DOM 扬了，导致退场动画根本没有视觉时间。
3. **关闭交互通道不闭环**：只在右上角提供了细小的 `X` 按钮，而没有支持用户下意识使用的“点击空白处（Backdrop）”与“按下 Esc 键”两项顶级系统的退出通道，降低了高阶弹窗控制台的尊贵感。

**修正方案**：
1. **`<style>` 稳定外部化**：将定义 Keyframes 的 `<style>` 标签从 Modal 条件分支中移出，放置在组件的最外层底部（无论 Modal 是否渲染均在 DOM 中稳定保持挂载）。由于 CSS 规则绝对稳定，退场类能在状态更新时 100% 毫无延迟地稳定响应并调用退出帧。
2. **原生 `onAnimationEnd` 零公差高精卸载**：废弃脆弱的 `setTimeout` 定时器。将 unmount 触发绑定在 Backdrop 根部容器的 `onAnimationEnd` 事件上，并在回调中严格验证 `event.target === event.currentTarget && isClosing`。这样，在 Backdrop 退出动画 `tt-fade-out`（0.2s）完全运行完毕的瞬间，刚好从 DOM 里卸载它，达到了物理时钟级别的零延迟精度对齐！
3. **闭环交互系统重构**：
   - **Backdrop 冒泡屏蔽点击关闭**：在 Backdrop div 挂载 `onClick` 处理器，判断只有 `e.target === e.currentTarget` 时触发 `handleCloseModal()`。
   - **全局 Escape 键盘退场监听**：在 `isModalOpen` 且未 `isClosing` 时启动全局 `keydown` 键盘监听，按下 `Escape` 即优雅开始退场，并在组件卸载/关闭时妥善回收 Listener 消除内存泄漏。

**规则**：
1. **Keyframe 定义严禁内联条件节点**：任何包含 `@keyframes` 的局部 `<style>` 或动态 CSS 注入，**绝对不能**放在由状态控制是否渲染的条件分支（如 `{isOpen && <Component />}`）中。必须将其放在外层稳定渲染的 DOM 节点里，确保样式表规则的生命周期与整个容器组件同寿，防止样式重建打断动画。
2. **React条件动效首选 `onAnimationEnd` 驱动卸载**：在不引入大型动画库（如 Motion）的纯原生 React 环境中，实现条件渲染的退场动画，**严禁**使用硬编码的 `setTimeout`。正确的黄金标准是让退出动画自己在最外层节点触发 `onAnimationEnd`，在事件回调里判断 `isClosing` 结束并卸载 DOM，实现 100% 的时差对齐。
3. **高级全屏容器的三关闭通道标准**：设计任何高级全屏弹窗、浮层、大控制台组件时，必须无条件提供**右上角X按钮**、**Backdrop空白处点击关闭（冒泡拦截）**、**全局 Escape 键按键监听**三条对称交互通道，且均应支持优雅的退出平滑过渡，才称得上是 Senior 级专业组件。
 
 ## 2026-05-23: 全局表现层多币种展示中，警惕遗留代码的硬编码符号拼装
 
 **背景**：在为项目引入全局人民币 (CNY / ¥) 和美元 (USD / $) 的多端动态折算展示时，我们将表现层核心格式化函数 `formatUsdCurrency` 进行了币种感知重构（即当处于 CNY 偏好时，自动应用 `7.25` 的汇率乘数并改用前缀符号 `¥`）。
 
 **问题**：
 1. **硬编码叠加**：但在 `dashboard/src/pages/DashboardPage.jsx` 的顶层概要卡片估算金额 `summaryCostValue` 的 `useMemo` 计算中，包含了一处历史遗留代码：
    ```javascript
    if (!formatted || formatted === "-" || formatted.startsWith("$")) return formatted;
    return `$${formatted}`;
    ```
 2. **逻辑脱节导致叠合**：这处历史代码在 `formatUsdCurrency` 以前只返回纯数字时为了确保有符号而加 of 兜底。但由于它只检测了 `.startsWith("$")` 并没有检测 `.startsWith("¥")`，当切换为人民币后，`formatted` 结果是 `¥21,315.21`。由于其不以 `$` 开头，代码强行执行了最后一行的拼接 `$`。最后导致界面上爆出了极度严重的 `$¥21,315.21` 双符号并存 Bug。
 
 **修正方案**：
 将 `DashboardPage.jsx` 中的判断兼容性改写，添加对 `¥` 符号的检查守卫，从而在两种货币下均只直接返回带货币符号的格式化字符串，消除二次拼装的隐患：

## 2026-05-23: 全局表现层多币种展示中，警惕遗留代码的硬编码符号拼装

**背景**：在为项目引入全局人民币 (CNY / ¥) 和美元 (USD / $) 的多端动态折算展示时，我们将表现层核心格式化函数 `formatUsdCurrency` 进行了币种感知重构（即当处于 CNY 偏好时，自动应用 `7.25` 的汇率乘数并改用前缀符号 `¥`）。

**问题**：
1. **硬编码叠加**：但在 `dashboard/src/pages/DashboardPage.jsx` 的顶层概要卡片估算金额 `summaryCostValue` 的 `useMemo` 计算中，包含了一处历史遗留代码：
   ```javascript
   if (!formatted || formatted === "-" || formatted.startsWith("$")) return formatted;
   return `$${formatted}`;
   ```
2. **逻辑脱节导致叠合**：这处历史代码在 `formatUsdCurrency` 以前只返回纯数字时为了确保有符号而加 of 兜底。但由于它只检测了 `.startsWith("$")` 并没有检测 `.startsWith("¥")`，当切换为人民币后，`formatted` 结果是 `¥21,315.21`。由于其不以 `$` 开头，代码强行执行了最后一行的拼接 `$`。最后导致界面上爆出了极度严重的 `$¥21,315.21` 双符号并存 Bug。

**修正方案**：
将 `DashboardPage.jsx` 中的判断兼容性改写，添加对 `¥` 符号的检查守卫，从而在两种货币下均只直接返回带货币符号的格式化字符串，消除二次拼装的隐患：
```javascript
if (!formatted || formatted === "-" || formatted.startsWith("$") || formatted.startsWith("¥")) return formatted;
return `$${formatted}`;
```

**规则**：
1. **警惕表现层二次包装**：任何时候重构底层基础格式化函数（例如将其从“单币种硬编码”重构为“自适应多币种格式化”）时，必须对**所有消费该函数的调用点（Consumer）**进行彻底的排查，仔细审阅消费端是否在调用后进行了硬编码的符号前/后缀二次包装，消除由于信息不对称产生的显示 Bug。
2. **符号与数据流归一化**：理想状态下，货币符号的拼装应 100% 由底层的格式化函数统一收编，业务组件只负责输出，严禁在业务端和逻辑端进行跨边界的符号渲染与数值拆分。

## 2026-05-26: 拒绝廉价而花哨的渐变卡片堆叠，遵循项目既定的极简与低调网页美学

**背景**：在被分配到优化 `/LeaderboardProfileModal` 的 UI 任务时，因急于追求所谓的“Rich Aesthetics”视觉冲击力，盲目堆砌了当下泛滥的多色饱和渐变卡片、炫目金银铜勋章 Rank Badge、呼吸火焰 🔥 图标以及大量的 Hover 浮动微移与弹出动画，偏离了项目本身类似于 OpenAI 的极简、知性与低调的极客网页风格。

**问题**：
1. **廉价花哨的套壳感**：高饱和度的品牌色渐变（`from-oai-brand-500/[0.06]`）、金银铜牌勋章等，对于专业的极客、开发者数据监控面板而言，极易显得廉价，不仅丧失了界面的工业设计高冷质感，更打乱了原先轻盈淡雅的统一性。
2. **多余的层级与卡片噪声**：原先扁平简约的信息流被大量包裹进厚重且自带阴影的多彩 Bento Cards 中，占用了极大的视觉空间，造成了严重的视觉噪点和信息割裂。
3. **忽略了核心体验组件（如骨架屏）的对齐**：在重构界面时只注重“卡片排版”，却忽略了数据在异步加载时，闪烁骨架屏（Skeleton Loader）与真实数据卡片的完美结构尺寸对齐，极易引发剧烈的布局飘移（Layout Shift）。

**修正方案**：
1. **回归 Flat Rows 与 Hairline 细框**：使用统一精细的微线边框（如 `border-oai-gray-200/80`）、无边框扁平 Stat 条（`grid grid-cols-4`）以及经典的 DL 属性列表排版（名值对 `FactRow`，灰色 dt，高亮 dd），把繁杂的信息流紧凑精练地合并为高雅的文字展示。
2. **高水准骨架屏（Skeleton）**：设计专门的 `ProfileSkeleton`，精细测量其尺寸，确保头部、Stat strip、Fact list、热力图、Provider 占比每一处的骨架色块高度和间距与加载完成后的内容 100% 同比例对齐，从根源消除布局飘动。
3. **采用细腻的细线进度条**：将进度条厚度保持在轻量的 `h-[3px]`，采用扁平背景，仅用淡雅的背景变化来支持 Hover 反馈，把科技质感和克制美学展现得淋漓尽致。

**规则**：
1. **深刻审视并融合既有设计系统**：接到 UI 优化任务时，**首先**应全面审视该项目已有的、由原作者设计的界面风格（是扁平高冷、紧凑极简，还是圆润多彩、卡片风）。重构代码必须做到“Surgical Changes & Match existing style, even if you'd do it differently”，绝对不能把自以为是的花哨审美强行塞入低调简约的成熟项目中。
2. **Stat 与 Fact 信息流的“脱卡”原则**：在极客类数据工具中，能用扁平字号、精致排版或紧凑的毛细横线（Hairline separators）划分的信息，优先考虑“去卡片化（De-cardification）”设计。多重卡片堆叠（Nested Bento Grid）极易产生严重的视觉碎裂与噪点。
3. **异步组件骨架对齐标准**：凡是涉及接口异步加载且包含骨架屏（Skeleton Loader）的页面，在修改真实展示结构的同时，**必须**同步等比例、等高度地更新对应的 Skeleton 骨架屏组件，坚决杜绝任何会导致 CLS（累积布局位移）的架构漏洞。

## 2026-05-27: 设计优化须严格遵循参考图结构比例，严禁脑补背景光晕与擅改品牌核心资产

**背景**：在优化 `/u/:userId` 的悬浮 Header 时，自作主张引入了旋转原子 SVG Logo 并且增加了过于浮夸的背景极光霓虹，偏离了用户仅仅要求“参考圆角矩形和毛玻璃排版”的真实意图，同时也因为把按钮做成了过扁的 `rounded-full` 胶囊，导致了用户的修正。

**问题**：
1. **篡改核心 Logo 品牌资产**：盲目将原有的 `/app-icon.png` 和 "Token Tracker" 标题扔掉换成了自定义的 SVG 旋转 React 原子和流光字，严重破坏了原有项目的品牌统一。
2. **脑补无端背景光晕**：加了高饱和度、高模糊的蓝紫发光气泡，让画面显得极度花哨和晃眼，干扰了用户对数据的正常审阅。
3. **结构与比例失真**：将 Header 容器和里面的按钮都设成了 `rounded-full` 胶囊形，而且按钮高度只有 `h-8.5` 导致垂直方向极扁、局促，完全丧失了参考图里「圆角矩形嵌套」的饱满和舒适感。

**修正方案**：
1. **移除光晕，回归本色**：彻底移除蓝紫发光极光气泡背景，让页面保持原本最纯净高雅的亮暗底色。
2. **无条件忠实品牌 Logo**：完整还原应用原本的 `/app-icon.png` 以及 uppercase 的 `"Token Tracker"` Logo 文字排版。
3. **熟练运用嵌套圆角美学**：将最外层 Header 容器重构为精致高冷的 **`rounded-2xl`（圆角矩形）** 浮动毛玻璃条；内部的 Leaderboard 按钮重构为 **`rounded-xl` 圆角矩形**，且高度调整为最饱满、最符合同心圆角比例的 **`h-9 px-4`**，形成了完美嵌套的同心圆角（Nested Corner）工程美学。

**规则**：
1. **不要脑补非必要的装饰特效**：当用户给出参考设计图时，重点参考其表现力（例如：圆角矩形还是全圆、是浮动还是直边、是普通毛玻璃还是多层渐变），绝对不要随意脑补类似极光光影、发光气泡、渐变背景等大范围侵入式噪点。
2. **绝对忠于原项目的 Logo 与品牌排版**：任何时候进行 UI 优化，只要原有的应用 Logo（图片、特定字体、大小写文字）可以工作，**必须无条件保留**。Logo 是品牌的核心所有权资产，绝不能在未授权下随意擅改或用其他图标替代。
3. **熟练掌握同心圆角嵌套原则**：设计精致圆角卡片嵌套（Nested Card Corners）时，外层容器如果是大圆角（如 `rounded-2xl`），内层按钮或卡片必须使用较小的圆角（如 `rounded-xl` 或 `rounded-lg`），并且两者的间距与大小要极其“合适”（如 `h-9` 对应 `h-14`），留出完美的 10px 绝对垂直居中呼吸感，彻底避免扁塌或扁扁的局促感。

## 2026-05-27: 响应式组件文本隐藏时，务必处理 Padding 导致的长宽比失衡与同类圆角对齐

**背景**：在优化 Landing Page 的 Header 右侧导航时，新增了 Leaderboard（排行榜）和 Dashboard / Sign In 按钮，但在窄屏（没有文字）时奖杯按钮变得极扁且与 Dashboard 按钮圆角极不搭。

**问题**：
1. **隐藏文本产生扁按钮**：Leaderboard 按钮原先绑定了 `px-3` 的左右内边距，当文本触发 `hidden xs:inline` 隐藏后，只有 14px 宽的 Trophy 图标加上 24px 的 padding 导致宽度为 38px。在一个高度为 32px 的容器中，这使得按钮呈现出尴尬且毫无美感的扁矩形，长宽比严重失衡。
2. **圆角不搭配的混乱**：Dashboard 按钮无意中呈现了类似胶囊的半圆状，而隔壁的奖杯按钮却是偏直角的圆角矩形。两种完全不同的圆角在同一行并列显得极其杂乱，严重打乱了圆角矩形的统一设计风格。

**修正方案**：
1. **精准正方形适配**：在窄屏下，将奖杯按钮的宽度强制设为 `w-8`（配合 `h-8`）并且将 padding 归零（`p-0`），使其成为一个极其对称的 `32x32px` 正方形。在宽屏 `xs:` 上再自动复原为 `xs:w-auto xs:px-3`，彻底解决了窄屏被压扁的视觉 Bug。
2. **强制硬圆角齐平**：放弃可能导致解析差异的 `rounded-lg`，为奖杯和 Dashboard/Sign In 按钮同时分配极度精确的 **`rounded-[8px]` (8px 圆角)**，并使其高度统一为 `h-8`。这让这一对功能按钮呈现出近乎绝对对称的圆角矩形秩序感。

**规则**：
1. **响应式图标按钮防扁化原则**：设计带有“隐藏文字”响应式控制的图标按钮时，在文字被隐藏（仅留图标）的视口下，**必须**将按钮尺寸归一化为正方形（例如 `w-8 h-8`、`w-9 h-9`），并且要重置 padding 属性，绝不能让残留的横向 padding 将纯图标按钮挤成丑陋的扁矩形。
2. **硬编码精确圆角对齐**：当有多个不同样式的行动按钮（如幽灵毛玻璃与白底实色）在同一容器或同一排中横向陈列时，它们的高度和圆角大小必须强制锁定一致（建议使用自定义 `rounded-[Npx]`），绝不能一边圆角较大显得像药丸胶囊，一边却像硬边矩形，这会直接击穿整体的工业质感。

## 2026-05-27: 严格区分本地开发与线上生产的登录/未登录态路由展示

**背景**：在重构 Landing Page 的 Header 时，将 Header 右侧的 `isLocalMode` 限制取消，但在重构时由于 `isLocalMode` 默认为 `true` 的条件干扰，漏配了线上 Cloud 模式未登录下多链接与登录按钮共存的交互层级。

**问题**：
在本地开发时，由于 `isLocalMode` 始终为 `true`，导致 `Dashboard / Sign In` 区域机械地只能匹配渲染实底的 `Open Dashboard` 按钮，而无法调试和检验线上真实未登录状态下的 “Sign In” 实底按钮，直接导致了线上未登录场景下 “Open Dashboard” 文字链接和 “Sign In” 主行动按钮的完全被切除。

**修正方案**：
通过完美的逻辑门控实现全模式自适应重构：
1. **线上未登录场景**：左侧多渲染一个次级普通文字链接 `Open Dashboard`，右侧将 `Sign In` 渲染为醒目的实底主行动按钮。
2. **已登录或本地场景**：左侧不渲染 `Open Dashboard` 文字链接，而是让右侧的 `Open Dashboard` 升级为醒目的实底主行动按钮，线上状态下头像 Rocky 紧随其后。
这样完美兼顾了线上未登录、线上已登录、本地调试三大场景的无缝适配！

**规则**：
1. **本地调试与线上态严格区分隔离**：凡是涉及本地开发模式（`isLocalMode`）会强行劫持/短路已登录/未登录判断逻辑（如强制认定为 Dashboard 状态）的组件，进行修改时必须人肉核查非本地（生产云端）下未登录态的代码路由分支，绝对不能因本地开发可见即主观认定线上可见。
2. **未登录导流梯度原则**：在官网 Landing Page 中，对于未登录用户，在 Header 中应采取「次级链接（导流至 Dashboard/Leaderboard 探索）+ 主行动按钮（引导注册登录）」的经典 SaaS Header 漏斗模型，保证即使未登录，用户也有清晰的探索入口。

## 2026-05-27: 异步弹窗二次开启时，务必在组件生命周期中重置 Loading 状态

**背景**：在调优 Login Modal 的骨架屏时，发现在第二次或后续开启弹窗时，骨架屏（Skeleton）完全没显示，依然呈现为“瞬间白屏空置，随后突然跳出 Google/GitHub 按钮”的延迟 Bug。

**问题**：
虽然首次挂载时 `configLoading` 的初始值为 `true` 能触发骨架屏，但一旦第一次加载成功，`configLoading` 被置为 `false`。由于 Modal 在关闭时并未被完全卸载 (Unmount)，第二次点击 Header 唤起登录弹窗时，`configLoading` 直接保持着上一次的 `false`！这导致在异步 `getPublicAuthConfig()` 响应前，整个 OAuth 按钮区域直接匹配渲染空数组，造成了严重的空白与高度跳变 Bug。

**修正方案**：
在 Modal 每次开启重置状态的 `useEffect` (依赖 `isOpen` 变化) 中，显式追加了重置 loading 状态的代码：
```javascript
useEffect(() => {
  if (isOpen) {
    ...
    setConfigLoading(true); // 每次打开弹窗时，必须显式重置为 Loading 状态，确保骨架屏 100% 成功播放
  }
}, [isOpen]);
```
这彻底保证了只要弹窗打开，在异步接口返回结果前的几十毫秒到几百毫秒内，**100% 会完美展示对称的双骨架屏占位**，加载完毕后淡入按钮，实现了极致顺滑、零位移的高端体验！

**规则**：
对于任何非卸载式挂载、会多次唤醒开启的异步弹窗（Modals/Dialogs），在重置其内部数据/输入框状态时，**必须无条件同步重置其异步加载状态 (Loading state) 为 true**。绝不能让复用的弹窗携带上一次加载完成的 false 态进入下一生命周期，否则必将引发恶性的视觉闪烁与布局弹跳 Bug。

## 2026-05-27: 警惕跨页面公共 Header 控件在未登录态下的胶囊样式残留

**背景**：在重构独立公开面板页面 `/u/:userId` 的悬浮 Header 时，发现在未登录状态下，右侧的 `Sign In` 按钮依然呈现出巨大、高度不齐平且风格冲突的 `rounded-full` 黑色胶囊药丸状，引发了极严重的视觉割裂 Bug。

**问题**：
因为此前在 `/u/:userId` 页面的 Header 右侧直接无门控地挂载了 `<InsforgeUserHeaderControls />`。虽然已登录时它能优雅输出 Rocky 圆形头像，但一旦处于未登录态，该组件内部会直接返回一个 `h-9`、`rounded-full` 的实底黑胶囊按钮。这与旁边 `h-8`、`rounded-lg` 矩形风格的 `Leaderboard` 返回按钮并排摆放，直接构成了一高一低、一圆一扁的灾难级违和画面。

**修正方案**：
将 `LeaderboardProfilePage.jsx` 页面的 Header 右侧进行完美的已登录/未登录分流解耦重构：
1. **已登录态**：仅在 `signedIn === true` 时挂载 `<InsforgeUserHeaderControls />`，只输出 32px 精致的圆形头像。
2. **未登录态**：不挂载 `InsforgeUserHeaderControls`，改由在外部手动渲染一个与 Leaderboard 按钮高度（`h-8`）和圆角（`rounded-lg`）完全同心齐平、最小宽度为 `min-w-[76px]` 的精致圆角矩形幽灵 `Sign In` 按钮！这在 Light / Dark 双模下呈现出极其高冷、秩序井然的科技极简美学！

**规则**：
1. **公共 auth 控件的外围分流防泄漏原则**：凡是包含未登录状态、但未登录态下样式并未完全实现“同心圆角、高度对齐”的公共账号身份组件（如 `InsforgeUserHeaderControls`），在非 App 主框架侧边栏（如独立的 Public pages）的精细 Header 中挂载时，**必须**在外层进行 `signedIn ? <AvatarControl /> : <CustomAlignedSignInButton />` 的条件重构。绝对不能直接把公共的胶囊按钮泄漏在讲究极致圆角矩形对齐的特制悬浮 Header 中。
2. **两横排按钮最高对称性原则**：在任何精品悬浮导航栏中，两个相邻的行动按钮如果不是明确 of 主次按钮（如一文字一按钮），只要并存，它们的高度和圆角大小必须强制物理锁定一致，绝对不能出现混用 capsule (胶囊) 与 rounded-rectangle (圆角矩形) 两种不同圆角体系的严重视觉低级错误。
## 2026-05-30: 排行榜前瞻动效版块严禁花哨多色渐变，必须遵循纯正极简的工业极客美学

**背景**：在 Landing Page 新增 Community Leaderboard 排行榜动效预览版块时，为了追求所谓的视觉冲击力，盲目堆砌了花里胡哨的金色渐变背景、皇冠 emoji（👑）以及大范围紫色极光发光泡。

**问题**：
1. **视觉噪点与廉价感**：对于严肃的开发者 CLI Token 监测工具而言，金色卡片和 emoji 堆叠极大削弱了界面的工业与科技质感，极易显得廉价，与 OpenAI 风格的克制、理性美学相悖。
2. **光影污染**：大范围、高饱和度的发光背景泡（blur 达 120px 的紫色圆形）构成了严重的视觉侵入性噪点，干扰了用户对冷峻代币数据的快速审阅。

**修正方案**：
1. **彻底移除光晕背景**：剔除所有浮夸的紫色、蓝色渐变发光大泡背景，让页面底盘保持纯净、干净的高冷黑。
2. **第一名去标签化与单色精细设计**：第一名卡片彻底移除金黄色渐变背景与皇冠 emoji。改用冷静干练的深灰微线边框（`border-oai-gray-800`），配合 `TiltedCard` 3D 特效做低调的物理质感凸显。
3. **极客 DL 信息排版**：内部文字和名次图标采用经典的同心圆角矩形，排名项采用极其硬朗对齐的 dl / fact 条展示，展现秩序感与克制感。

**规则**：
1. **严禁在严肃极客页面脑补彩色发光气泡与金色卡片**：AI Token 监控等偏硬核开发者工具的 Landing Page 优化，绝对禁止盲目引入彩色发光球与高对比渐变 Bento 卡片。应当通过极其精确的排版间距、冷静的冷灰色调（如 `#080808` 至 `#121212`）与极细的高精发光边框（Hairline glow）来塑造高级感。
2. **无条件禁止 emoji 作为界面核心装饰元素**：在界面前瞻或主面板中，代表名次的装饰必须使用严密的同心圆角矩形 Badge 或纯文字/纯数字图标，严禁直接使用 "👑"、"🔥" 等极具娱乐性与业余感的原生绘文字。
