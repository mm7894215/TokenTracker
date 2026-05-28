import Foundation

enum Strings {
    private static var loc: String { NativeLocalization.currentResolvedLocale }

    /// Pick the string for the active resolved locale. English is the base; the
    /// other four are always supplied (zh-TW is OpenCC s2twp of zh-CN, ja/ko are
    /// authored translations).
    private static func t(_ en: String, _ zhCN: String, _ zhTW: String, _ ja: String, _ ko: String) -> String {
        switch loc {
        case NativeLocalization.chineseLocale: return zhCN
        case NativeLocalization.traditionalChineseLocale: return zhTW
        case NativeLocalization.japaneseLocale: return ja
        case NativeLocalization.koreanLocale: return ko
        default: return en
        }
    }

    private static func tArr(_ en: [String], _ zhCN: [String], _ zhTW: [String], _ ja: [String], _ ko: [String]) -> [String] {
        switch loc {
        case NativeLocalization.chineseLocale: return zhCN
        case NativeLocalization.traditionalChineseLocale: return zhTW
        case NativeLocalization.japaneseLocale: return ja
        case NativeLocalization.koreanLocale: return ko
        default: return en
        }
    }

    static var appTitle: String { "TokenTracker" }
    static var serverUnavailable: String { t("Server Unavailable", "服务器不可用", "伺服器不可用", "サーバーを利用できません", "서버를 사용할 수 없음") }
    static var serverStarting: String { t("Starting TokenTracker", "正在启动 TokenTracker", "正在啟動 TokenTracker", "TokenTracker を起動中", "TokenTracker 시작 중") }
    static var serverPreparing: String { t("This usually takes a few seconds.", "通常只需要几秒钟。", "通常只需要幾秒鐘。", "通常は数秒で完了します。", "보통 몇 초 정도 걸립니다.") }
    static var loadingData: String { t("Loading data…", "正在加载数据…", "正在載入資料…", "データを読み込み中…", "데이터 불러오는 중…") }
    static var noData: String { t("No data", "暂无数据", "暫無資料", "データなし", "데이터 없음") }
    static var retryButton: String { t("Retry", "重试", "重試", "再試行", "다시 시도") }
    static var openDashboard: String { t("Open Dashboard", "打开仪表盘", "開啟儀表盤", "ダッシュボードを開く", "대시보드 열기") }
    static var quitButton: String { t("Quit", "退出", "退出", "終了", "종료") }
    static var justNow: String { t("just now", "刚刚", "剛剛", "たった今", "방금") }
    static var activityTitle: String { t("Activity", "活跃度", "活躍度", "アクティビティ", "활동") }
    static var trendTitle: String { t("Trend", "趋势", "趨勢", "トレンド", "추세") }
    static var topModelsTitle: String { t("Models", "模型", "模型", "モデル", "모델") }
    static var modelBreakdownTitle: String { t("Model Breakdown", "模型明细", "模型明細", "モデル別内訳", "모델별 분석") }
    static var todayTitle: String { t("Today", "今日", "今日", "今日", "오늘") }
    static var sevenDayTitle: String { t("7-Day", "7 天", "7 天", "7日間", "7일") }
    static var thirtyDayTitle: String { t("30-Day", "30 天", "30 天", "30日間", "30일") }
    static var perDay: String { t("/day", "/天", "/天", "/日", "/일") }
    static var hintTrend: String { t("Usage trend appears after your first AI session", "首次 AI 会话后会显示使用趋势", "首次 AI 會話後會顯示使用趨勢", "最初の AI セッション後に使用トレンドが表示されます", "첫 AI 세션 이후 사용 추세가 표시됩니다") }
    static var hintBreakdown: String { t("Model data appears after your first AI session", "首次 AI 会话后会显示模型数据", "首次 AI 會話後會顯示模型資料", "最初の AI セッション後にモデルデータが表示されます", "첫 AI 세션 이후 모델 데이터가 표시됩니다") }
    static var periodTotal: String { t("Period", "周期", "週期", "期間", "기간") }
    static var conversations: String { t("conversations", "次对话", "次對話", "会話", "대화") }
    static var totalTitle: String { t("Total", "总计", "總計", "合計", "합계") }
    static var hintModels: String { t("Model data appears after your first AI session", "首次 AI 会话后会显示模型数据", "首次 AI 會話後會顯示模型資料", "最初の AI セッション後にモデルデータが表示されます", "첫 AI 세션 이후 모델 데이터가 표시됩니다") }
    static var serverStartingSubtitle: String { t("Starting local server…", "正在启动本地服务…", "正在啟動本地服務…", "ローカルサーバーを起動中…", "로컬 서버 시작 중…") }
    static var serverStartingHint: String { t("This usually takes a few seconds.", "通常只需要几秒钟。", "通常只需要幾秒鐘。", "通常は数秒で完了します。", "보통 몇 초 정도 걸립니다.") }
    static var serverOfflineHint: String {
        t("Check that tokentracker-cli is installed and try again.", "请检查 tokentracker-cli 是否已安装，然后重试。", "請檢查 tokentracker-cli 是否已安裝，然後重試。", "tokentracker-cli がインストールされているか確認して、もう一度お試しください。", "tokentracker-cli가 설치되어 있는지 확인한 후 다시 시도하세요.")
    }

    static var usageLimitsTitle: String { t("Limits", "限额", "限額", "上限", "한도") }
    static var sessionExpired: String { t("Session expired", "会话已过期", "會話已過期", "セッションが期限切れです", "세션이 만료되었습니다") }
    static var allProvidersHidden: String { t("All providers hidden", "所有提供方均已隐藏", "所有提供方均已隱藏", "すべてのプロバイダーが非表示です", "모든 제공자가 숨겨졌습니다") }
    static var cursorPlanLabel: String { t("Plan", "套餐", "套餐", "プラン", "플랜") }
    static var cursorAutoLabel: String { t("Auto", "自动", "自動", "自動", "자동") }
    static var kimiWeeklyLabel: String { t("Weekly", "周", "周", "週間", "주간") }
    static var kimiFiveHourLabel: String { t("5h", "5h", "5h", "5h", "5h") }
    static var kimiTotalLabel: String { t("Total", "总量", "總量", "合計", "총량") }
    static var kiroMonthLabel: String { t("Month", "本月", "本月", "今月", "이번 달") }
    static var kiroBonusLabel: String { t("Bonus", "奖励", "獎勵", "ボーナス", "보너스") }
    static var limitResetNow: String { t("now", "现在", "現在", "今", "지금") }
    static func kimiParallelLabel(_ count: Int) -> String {
        t("Parallel: \(count)", "并发：\(count)", "併發：\(count)", "並列：\(count)", "병렬: \(count)")
    }

    static var periodDayLabel: String { t("Day", "日", "日", "日", "일") }
    static var periodWeekLabel: String { t("Week", "周", "周", "週", "주") }
    static var periodMonthLabel: String { t("Month", "月", "月", "月", "월") }
    static var periodTotalLabel: String { t("Total", "总计", "總計", "合計", "합계") }

    static func topModelAccessibility(name: String, source: String, tokens: String, percent: String) -> String {
        t(
            "\(name), \(source), \(tokens) tokens, \(percent) percent",
            "\(name)，\(source)，\(tokens) tokens，\(percent)",
            "\(name)，\(source)，\(tokens) tokens，\(percent)",
            "\(name)、\(source)、\(tokens) tokens、\(percent)",
            "\(name), \(source), \(tokens) tokens, \(percent)"
        )
    }
    static var syncingUsageData: String { t("Syncing usage data…", "正在同步使用数据…", "正在同步使用資料…", "使用データを同期中…", "사용 데이터 동기화 중…") }
    static var syncingFirstLaunchHint: String { t("First launch may take a moment", "首次启动可能需要一点时间", "首次啟動可能需要一點時間", "初回起動は少し時間がかかる場合があります", "첫 실행은 잠시 시간이 걸릴 수 있습니다") }
    static var limitsDisplayTitle: String { t("Limit Display", "限额显示", "限額顯示", "上限の表示", "한도 표시") }

    static var menuSyncNow: String { t("Sync Now", "立即同步", "立即同步", "今すぐ同期", "지금 동기화") }
    static var menuCheckForUpdates: String { t("Check for Updates…", "检查更新…", "檢查更新…", "アップデートを確認…", "업데이트 확인…") }
    static var menuLaunchAtLogin: String { t("Launch at Login", "登录时启动", "登入時啟動", "ログイン時に起動", "로그인 시 실행") }
    static var menuStarOnGitHub: String { t("★ Star on GitHub", "★ 在 GitHub 上标星", "★ 在 GitHub 上標星", "★ GitHub でスターを付ける", "★ GitHub에서 스타하기") }
    static var menuShowStats: String { t("Show Stats in Menu Bar", "在菜单栏显示统计", "在選單欄顯示統計", "メニューバーに統計を表示", "메뉴 막대에 통계 표시") }
    static var menuAnimatedIcon: String { t("Animated Icon", "动态图标", "動態圖示", "アニメーションアイコン", "애니메이션 아이콘") }
    static var menuSettings: String { t("Settings", "设置", "設定", "設定", "설정") }
    // Status-bar inline label (Tokens / Cost) always stays English — it sits
    // next to the menu bar number and should not swap with system language.
    static var menuTokenLabel: String { "Tokens" }
    static var menuCostLabel: String { "Cost" }
    static var tokensUnit: String { t("tokens", "tokens", "tokens", "tokens", "tokens") }
    static var heatmapLegendLess: String { t("Less", "少", "少", "少ない", "적음") }
    static var heatmapLegendMore: String { t("More", "多", "多", "多い", "많음") }
    static var trendAccessibilityLabel: String { t("Token usage trend chart", "Token 使用趋势图", "Token 使用趨勢圖", "トークン使用量トレンドグラフ", "토큰 사용량 추세 차트") }
    static var syncUsageData: String { t("Sync usage data", "同步使用数据", "同步使用資料", "使用データを同期", "사용 데이터 동기화") }
    static var addWidgetsTitle: String { t("Add TokenTracker widgets", "添加 TokenTracker 小组件", "新增 TokenTracker 小元件", "TokenTracker ウィジェットを追加", "TokenTracker 위젯 추가") }
    static var addWidgetsMessage: String {
        t(
            "Right-click an empty area of your desktop, choose \"Edit Widgets\", then search for \"TokenTracker\" in the gallery.",
            "右键点击桌面空白处，选择“编辑小组件”，然后在小组件库中搜索“TokenTracker”。",
            "右鍵點選桌面空白處，選擇“編輯小元件”，然後在小元件庫中搜索“TokenTracker”。",
            "デスクトップの空いている場所を右クリックし、「ウィジェットを編集」を選択して、ギャラリーで「TokenTracker」を検索してください。",
            "바탕화면의 빈 공간을 마우스 오른쪽 버튼으로 클릭하고 \"위젯 편집\"을 선택한 다음 갤러리에서 \"TokenTracker\"를 검색하세요."
        )
    }
    static var gotItButton: String { t("Got it", "知道了", "知道了", "了解", "확인") }

    static var serverNotAvailableMessage: String {
        t(
            "TokenTracker server not available.\nPlease reinstall the app or install: npm install -g tokentracker-cli",
            "TokenTracker 服务不可用。\n请重新安装应用，或运行：npm install -g tokentracker-cli",
            "TokenTracker 服務不可用。\n請重新安裝應用，或執行：npm install -g tokentracker-cli",
            "TokenTracker サーバーを利用できません。\nアプリを再インストールするか、次を実行してください：npm install -g tokentracker-cli",
            "TokenTracker 서버를 사용할 수 없습니다.\n앱을 재설치하거나 다음을 설치하세요: npm install -g tokentracker-cli"
        )
    }
    static func serverNotResponding(port: Int) -> String {
        t("Server started but not responding on port \(port).", "服务已启动，但端口 \(port) 无响应。", "服務已啟動，但埠 \(port) 無響應。", "サーバーは起動しましたが、ポート \(port) で応答がありません。", "서버가 시작되었지만 포트 \(port)에서 응답이 없습니다.")
    }
    static var serverExitedUnexpectedly: String { t("Server process exited unexpectedly.", "服务进程意外退出。", "服務程序意外退出。", "サーバープロセスが予期せず終了しました。", "서버 프로세스가 예기치 않게 종료되었습니다.") }
    static func embeddedServerLaunchFailed(_ error: String) -> String {
        t("Failed to launch embedded server: \(error)", "启动内置服务失败：\(error)", "啟動內建服務失敗：\(error)", "内蔵サーバーの起動に失敗しました：\(error)", "내장 서버 실행에 실패했습니다: \(error)")
    }
    static func serverLaunchFailed(_ error: String) -> String {
        t("Failed to launch server: \(error)", "启动服务失败：\(error)", "啟動服務失敗：\(error)", "サーバーの起動に失敗しました：\(error)", "서버 실행에 실패했습니다: \(error)")
    }
    static var serverBecameUnreachable: String { t("Server became unreachable.", "服务已不可访问。", "服務已不可訪問。", "サーバーに接続できなくなりました。", "서버에 연결할 수 없게 되었습니다.") }

    static var updateChecking: String { t("Checking for updates...", "正在检查更新...", "正在檢查更新...", "アップデートを確認中...", "업데이트 확인 중...") }
    static func updateSkipped(target: String, current: String) -> String {
        t(
            "Auto-update skipped: \(target) reports as \(current). Reinstall manually.",
            "已跳过自动更新：\(target) 显示为 \(current)。请手动重新安装。",
            "已跳過自動更新：\(target) 顯示為 \(current)。請手動重新安裝。",
            "自動アップデートをスキップしました：\(target) は \(current) と表示されています。手動で再インストールしてください。",
            "자동 업데이트를 건너뜀: \(target)이(가) \(current)(으)로 표시됩니다. 수동으로 재설치하세요."
        )
    }
    static var upToDateTitle: String { t("You're Up to Date", "已是最新版本", "已是最新版本", "最新の状態です", "최신 버전입니다") }
    static func upToDateMessage(_ version: String) -> String {
        t("Version \(version) is the latest version.", "\(version) 已是最新版本。", "\(version) 已是最新版本。", "バージョン \(version) は最新です。", "버전 \(version)이(가) 최신입니다.")
    }
    static var updateCheckFailedTitle: String { t("Update Check Failed", "检查更新失败", "檢查更新失敗", "アップデートの確認に失敗", "업데이트 확인 실패") }
    static var manualCheckHint: String { t("You can also check manually:", "你也可以手动检查：", "你也可以手動檢查：", "手動で確認することもできます：", "수동으로 확인할 수도 있습니다:") }
    static func newVersionTitle(_ version: String) -> String {
        t("New Version Available — \(version)", "发现新版本 — \(version)", "發現新版本 — \(version)", "新しいバージョンがあります — \(version)", "새 버전 사용 가능 — \(version)")
    }
    static var downloadInstallButton: String { t("Download & Install", "下载并安装", "下載並安裝", "ダウンロードしてインストール", "다운로드 및 설치") }
    static var viewOnGitHubButton: String { t("View on GitHub", "在 GitHub 查看", "在 GitHub 檢視", "GitHub で見る", "GitHub에서 보기") }
    static var laterButton: String { t("Later", "稍后", "稍後", "後で", "나중에") }
    static func updateCurrentLine(current: String, target: String) -> String {
        t("Current: \(current) → \(target)", "当前版本：\(current) → \(target)", "當前版本：\(current) → \(target)", "現在：\(current) → \(target)", "현재: \(current) → \(target)")
    }
    static var releaseNotesTitle: String { t("Release Notes:", "更新说明：", "更新說明：", "リリースノート：", "릴리스 노트:") }
    static func updateSize(_ size: String) -> String { t("Size: \(size) MB", "大小：\(size) MB", "大小：\(size) MB", "サイズ：\(size) MB", "크기: \(size) MB") }
    static var downloadFailedTitle: String { t("Download Failed", "下载失败", "下載失敗", "ダウンロードに失敗", "다운로드 실패") }
    static var invalidDownloadURL: String {
        t("Invalid download URL.\n\nYou can download manually from the Releases page.", "下载 URL 无效。\n\n你可以从 Releases 页面手动下载。", "下載 URL 無效。\n\n你可以從 Releases 頁面手動下載。", "ダウンロード URL が無効です。\n\nReleases ページから手動でダウンロードできます。", "다운로드 URL이 잘못되었습니다.\n\nReleases 페이지에서 수동으로 다운로드할 수 있습니다.")
    }
    static var manualDownloadHint: String {
        t("You can download manually from the Releases page.", "你可以从 Releases 页面手动下载。", "你可以從 Releases 頁面手動下載。", "Releases ページから手動でダウンロードできます。", "Releases 페이지에서 수동으로 다운로드할 수 있습니다.")
    }
    static var downloadingUnknown: String { t("Downloading…", "正在下载…", "正在下載…", "ダウンロード中…", "다운로드 중…") }
    static func downloadingPercent(_ pct: Int) -> String { t("Downloading \(pct)%...", "正在下载 \(pct)%...", "正在下載 \(pct)%...", "ダウンロード中 \(pct)%...", "다운로드 중 \(pct)%...") }
    static func downloadingProgress(pct: Int, receivedMB: String, totalMB: String) -> String {
        t("Downloading \(pct)% (\(receivedMB)/\(totalMB) MB)", "正在下载 \(pct)%（\(receivedMB)/\(totalMB) MB）", "正在下載 \(pct)%（\(receivedMB)/\(totalMB) MB）", "ダウンロード中 \(pct)%（\(receivedMB)/\(totalMB) MB）", "다운로드 중 \(pct)% (\(receivedMB)/\(totalMB) MB)")
    }
    static var installing: String { t("Installing...", "正在安装...", "正在安裝...", "インストール中...", "설치 중...") }
    static var restarting: String { t("Restarting...", "正在重启...", "正在重啟...", "再起動中...", "재시작 중...") }
    static var installationFailedTitle: String { t("Installation Failed", "安装失败", "安裝失敗", "インストールに失敗", "설치 실패") }
    static var manualInstallHint: String {
        t("Please drag TokenTrackerBar into Applications manually.", "请手动将 TokenTrackerBar 拖入“应用程序”。", "請手動將 TokenTrackerBar 拖入“應用程式”。", "TokenTrackerBar を手動で「アプリケーション」にドラッグしてください。", "TokenTrackerBar를 수동으로 응용 프로그램 폴더로 드래그하세요.")
    }
    static var updateCompleteTitle: String { t("Update Complete", "更新完成", "更新完成", "アップデート完了", "업데이트 완료") }
    static var updateCompleteMessage: String {
        t("New version installed to /Applications. Please restart manually.", "新版本已安装到 /Applications。请手动重启。", "新版本已安裝到 /Applications。請手動重啟。", "新しいバージョンを /Applications にインストールしました。手動で再起動してください。", "새 버전을 /Applications에 설치했습니다. 수동으로 재시작하세요.")
    }
    static var openReleasesPageButton: String { t("Open Releases Page", "打开 Releases 页面", "開啟 Releases 頁面", "Releases ページを開く", "Releases 페이지 열기") }
    static var okButton: String { t("OK", "好", "好", "OK", "확인") }
    static func networkRequestFailed(code: Int) -> String {
        t("Network request failed (HTTP \(code)). Check your connection or proxy settings.", "网络请求失败（HTTP \(code)）。请检查网络连接或代理设置。", "網路請求失敗（HTTP \(code)）。請檢查網路連線或代理設定。", "ネットワークリクエストに失敗しました（HTTP \(code)）。接続またはプロキシ設定を確認してください。", "네트워크 요청에 실패했습니다 (HTTP \(code)). 연결 또는 프록시 설정을 확인하세요.")
    }
    static var emptyServerResponse: String { t("Server returned an empty response.", "服务器返回了空响应。", "伺服器返回了空響應。", "サーバーが空の応答を返しました。", "서버가 빈 응답을 반환했습니다.") }
    static var fileDownloadFailed: String { t("File download failed. This may be a network issue.", "文件下载失败，可能是网络问题。", "檔案下載失敗，可能是網路問題。", "ファイルのダウンロードに失敗しました。ネットワークの問題の可能性があります。", "파일 다운로드에 실패했습니다. 네트워크 문제일 수 있습니다.") }
    static func installFailed(_ reason: String) -> String { t("Installation failed: \(reason)", "安装失败：\(reason)", "安裝失敗：\(reason)", "インストールに失敗しました：\(reason)", "설치에 실패했습니다: \(reason)") }
    static var noReleaseAvailable: String { t("No release available.", "暂无可用发布版本。", "暫無可用釋出版本。", "利用可能なリリースがありません。", "사용 가능한 릴리스가 없습니다.") }

    static func minutesAgo(_ n: Int) -> String { t("\(n)m ago", "\(n) 分钟前", "\(n) 分鐘前", "\(n)分前", "\(n)분 전") }
    static func hoursAgo(_ n: Int) -> String { t("\(n)h ago", "\(n) 小时前", "\(n) 小時前", "\(n)時間前", "\(n)시간 전") }
    static func daysAgo(_ n: Int) -> String { t("\(n)d ago", "\(n) 天前", "\(n) 天前", "\(n)日前", "\(n)일 전") }
    static func activeDays(_ n: Int) -> String { t("\(n) active days", "\(n) 个活跃日", "\(n) 個活躍日", "\(n) アクティブ日", "활동일 \(n)일") }
    static func activeDaysThisWeek(_ n: Int) -> String { t("\(n) active days this week", "本周 \(n) 个活跃日", "本週 \(n) 個活躍日", "今週 \(n) アクティブ日", "이번 주 활동일 \(n)일") }
    static func tokensToday(_ tokens: String) -> String { t("📊 Today: \(tokens) tokens", "📊 今日：\(tokens) tokens", "📊 今日：\(tokens) tokens", "📊 今日：\(tokens) tokens", "📊 오늘: \(tokens) tokens") }
    static func tokensSpentToday(tokens: String, cost: String) -> String {
        t("📈 \(tokens) tokens — \(cost) spent today", "📈 今日 \(tokens) tokens，花费 \(cost)", "📈 今日 \(tokens) tokens，花費 \(cost)", "📈 今日 \(tokens) tokens、\(cost) 使用", "📈 오늘 \(tokens) tokens, \(cost) 지출")
    }
    static func aiInvestedToday(_ cost: String) -> String { t("💰 \(cost) invested in AI so far", "💰 今日 AI 投入：\(cost)", "💰 今日 AI 投入：\(cost)", "💰 これまでの AI 投資：\(cost)", "💰 지금까지 AI 투자: \(cost)") }
    static func billToday(cost: String, tokens: String) -> String {
        t("🧾 Today's bill: \(cost) for \(tokens) tokens", "🧾 今日账单：\(cost)，\(tokens) tokens", "🧾 今日賬單：\(cost)，\(tokens) tokens", "🧾 今日の請求：\(cost)（\(tokens) tokens）", "🧾 오늘 청구: \(cost), \(tokens) tokens")
    }
    static func aiTabToday(_ cost: String) -> String { t("💳 AI tab today: \(cost)", "💳 今日 AI 账单：\(cost)", "💳 今日 AI 賬單：\(cost)", "💳 今日の AI 利用料：\(cost)", "💳 오늘 AI 비용: \(cost)") }
    static func sevenDayTotal(_ tokens: String) -> String { t("📅 7-day total: \(tokens) tokens", "📅 7 天总计：\(tokens) tokens", "📅 7 天總計：\(tokens) tokens", "📅 7日間合計：\(tokens) tokens", "📅 7일 합계: \(tokens) tokens") }
    static var perfectStreak: String { t("🏆 7/7 active days — perfect streak!", "🏆 7/7 活跃日，完美连续！", "🏆 7/7 活躍日，完美連續！", "🏆 7/7 アクティブ日 — 完璧な連続記録！", "🏆 7/7 활동일 — 완벽한 연속 기록!") }
    static func thirtyDayTotal(_ tokens: String) -> String { t("📆 30-day total: \(tokens) tokens", "📆 30 天总计：\(tokens) tokens", "📆 30 天總計：\(tokens) tokens", "📆 30日間合計：\(tokens) tokens", "📆 30일 합계: \(tokens) tokens") }
    static func averagingPerDay(_ tokens: String) -> String { t("📊 Averaging ~\(tokens)/day this month", "📊 本月平均约 \(tokens)/天", "📊 本月平均約 \(tokens)/天", "📊 今月は平均約 \(tokens)/日", "📊 이번 달 하루 평균 ~\(tokens)") }
    static func streakDays(_ n: Int) -> String { t("🔥 \(n)-day streak! Keep it going", "🔥 连续 \(n) 天！继续保持", "🔥 連續 \(n) 天！繼續保持", "🔥 \(n)日連続！この調子で", "🔥 \(n)일 연속! 계속 가요") }
    static func activeDaysAllTime(_ n: Int) -> String { t("📈 \(n) active days all-time!", "📈 累计 \(n) 个活跃日！", "📈 累計 \(n) 個活躍日！", "📈 累計 \(n) アクティブ日！", "📈 누적 활동일 \(n)일!") }
    static func topModel(_ name: String, _ percent: String) -> String { t("🥇 Top model: \(name) (\(percent))", "🥇 最常用模型：\(name)（\(percent)）", "🥇 最常用模型：\(name)（\(percent)）", "🥇 最も使用したモデル：\(name)（\(percent)）", "🥇 최다 사용 모델: \(name) (\(percent))") }
    static func runnerUp(_ name: String, _ percent: String) -> String { t("🥈 Runner-up: \(name) at \(percent)", "🥈 第二名：\(name)，\(percent)", "🥈 第二名：\(name)，\(percent)", "🥈 2位：\(name)（\(percent)）", "🥈 2위: \(name), \(percent)") }
    static func modelCount(_ count: Int) -> String { t("🧰 Using \(count) different models", "🧰 使用了 \(count) 个不同模型", "🧰 使用了 \(count) 個不同模型", "🧰 \(count) 種類のモデルを使用中", "🧰 서로 다른 모델 \(count)개 사용 중") }
    static func multiToolSetup(_ names: String) -> String { t("🔀 Multi-tool setup: \(names)", "🔀 多工具组合：\(names)", "🔀 多工具組合：\(names)", "🔀 マルチツール構成：\(names)", "🔀 멀티 툴 구성: \(names)") }
    static func conversationsToday(_ count: Int) -> String {
        t("💬 \(count) conversation\(count == 1 ? "" : "s") today", "💬 今日 \(count) 次对话", "💬 今日 \(count) 次對話", "💬 今日 \(count) 件の会話", "💬 오늘 대화 \(count)건")
    }
    static func busyTalker(_ count: Int) -> String { t("🗣️ \(count) chats! Busy talker today", "🗣️ \(count) 次聊天，今天很忙", "🗣️ \(count) 次聊天，今天很忙", "🗣️ \(count) 回のチャット！今日はおしゃべり", "🗣️ 채팅 \(count)회! 오늘 수다스럽네요") }

    static var syncingQuips: [String] {
        tArr(
            ["⏳ Crunching numbers...", "📡 Fetching latest data!", "🔄 One moment, syncing...", "🧮 Counting your tokens~"],
            ["⏳ 正在计算数据...", "📡 正在获取最新数据！", "🔄 稍等，正在同步...", "🧮 正在统计 tokens~"],
            ["⏳ 正在計算資料...", "📡 正在獲取最新資料！", "🔄 稍等，正在同步...", "🧮 正在統計 tokens~"],
            ["⏳ 計算中...", "📡 最新データを取得中！", "🔄 少々お待ちを、同期中...", "🧮 トークンを数えています~"],
            ["⏳ 계산 중...", "📡 최신 데이터 가져오는 중!", "🔄 잠시만요, 동기화 중...", "🧮 토큰을 세는 중~"]
        )
    }
    static var emptyTodayQuips: [String] {
        tArr(
            ["😴 No tokens yet today", "💬 Start chatting to wake me up!", "🌙 Quiet day so far...", "⌨️ Waiting for your first prompt", "💤 Zzz... nothing to count", "🌅 The calm before the storm?", "✨ I'm ready when you are!"],
            ["😴 今天还没有 tokens", "💬 发起一次对话来唤醒我！", "🌙 今天暂时很安静...", "⌨️ 等待你的第一个 prompt", "💤 Zzz... 还没有可统计内容", "🌅 风暴前的平静？", "✨ 我已经准备好了！"],
            ["😴 今天還沒有 tokens", "💬 發起一次對話來喚醒我！", "🌙 今天暫時很安靜...", "⌨️ 等待你的第一個 prompt", "💤 Zzz... 還沒有可統計內容", "🌅 風暴前的平靜？", "✨ 我已經準備好了！"],
            ["😴 今日はまだトークンなし", "💬 話しかけて起こして！", "🌙 今のところ静かな一日...", "⌨️ 最初のプロンプトを待っています", "💤 Zzz... 数えるものがありません", "🌅 嵐の前の静けさ？", "✨ いつでも準備OK！"],
            ["😴 오늘은 아직 토큰이 없어요", "💬 말을 걸어 깨워주세요!", "🌙 아직은 조용한 하루...", "⌨️ 첫 프롬프트를 기다리는 중", "💤 Zzz... 셀 게 없네요", "🌅 폭풍 전의 고요?", "✨ 준비됐어요!"]
        )
    }
    static var warmupQuips: [String] {
        tArr(["☕ Just warming up!", "🌱 A gentle start"], ["☕ 刚刚热身！", "🌱 温和开局"], ["☕ 剛剛熱身！", "🌱 溫和開局"], ["☕ ウォームアップ中！", "🌱 穏やかな滑り出し"], ["☕ 이제 막 시동 중!", "🌱 잔잔한 출발"])
    }
    static var flowQuips: [String] {
        tArr(["🎯 Getting into the flow!", "💪 Solid progress today"], ["🎯 开始进入状态！", "💪 今天进展不错"], ["🎯 開始進入狀態！", "💪 今天進展不錯"], ["🎯 調子が出てきた！", "💪 今日は順調"], ["🎯 흐름을 타는 중!", "💪 오늘 순조로워요"])
    }
    static var busyQuips: [String] {
        tArr(["🔥 Busy day!", "⚡ You're on a roll!"], ["🔥 今天很忙！", "⚡ 状态正佳！"], ["🔥 今天很忙！", "⚡ 狀態正佳！"], ["🔥 忙しい一日！", "⚡ 絶好調！"], ["🔥 바쁜 하루!", "⚡ 물 올랐어요!"])
    }
    static var heavyQuips: [String] {
        tArr(["🚀 Heavy usage today!", "🖨️ Token machine goes brrr"], ["🚀 今天用量很高！", "🖨️ Token 机器启动"], ["🚀 今天用量很高！", "🖨️ Token 機器啟動"], ["🚀 今日は使用量が多い！", "🖨️ トークンマシン全開"], ["🚀 오늘 사용량 많네요!", "🖨️ 토큰 머신 풀가동"])
    }
    static var massiveQuips: [String] {
        tArr(["🤯 MASSIVE day!", "🔥 Token counter on fire!"], ["🤯 今天用量爆表！", "🔥 Token 计数器燃起来了！"], ["🤯 今天用量爆表！", "🔥 Token 計數器燃起來了！"], ["🤯 爆発的な一日！", "🔥 トークンカウンター炎上中！"], ["🤯 폭발적인 하루!", "🔥 토큰 카운터 불났어요!"])
    }
    static var personalityQuips: [String] {
        tArr(
            ["👆 Tap me for more!", "📋 I count so you don't have to", "✨ Every token tells a story", "🤝 Your AI spending buddy", "👋 Hey there~"],
            ["👆 点我查看更多！", "📋 我来帮你计数", "✨ 每个 token 都有故事", "🤝 你的 AI 花费伙伴", "👋 你好呀~"],
            ["👆 點我檢視更多！", "📋 我來幫你計數", "✨ 每個 token 都有故事", "🤝 你的 AI 花費夥伴", "👋 你好呀~"],
            ["👆 タップして詳細表示！", "📋 数えるのは私にお任せ", "✨ どのトークンにも物語がある", "🤝 あなたの AI 支出の相棒", "👋 やあ~"],
            ["👆 더 보려면 탭하세요!", "📋 세는 건 제가 할게요", "✨ 모든 토큰엔 이야기가 있죠", "🤝 당신의 AI 지출 친구", "👋 안녕하세요~"]
        )
    }

    static func limitAccessibility(toolName: String, label: String, percent: Int, reset: String?) -> String {
        let base = t("\(toolName) \(label) limit, \(percent)%", "\(toolName) \(label) 限额，\(percent)%", "\(toolName) \(label) 限額，\(percent)%", "\(toolName) \(label) 上限、\(percent)%", "\(toolName) \(label) 한도, \(percent)%")
        guard let reset else { return base }
        return t("\(base), resets in \(reset)", "\(base)，\(reset) 后重置", "\(base)，\(reset) 後重置", "\(base)、\(reset) 後にリセット", "\(base), \(reset) 후 초기화")
    }
}
