namespace TokenTrackerWin;

internal sealed record TrayStrings(
    string FontFamily,
    string TodayTitle,
    string NoData,
    string TokensUnit,
    string OpenDashboard,
    string SyncNow,
    string LaunchAtLogin,
    string StarOnGitHub,
    string Quit)
{
    public static TrayStrings For(string locale)
    {
        return locale switch
        {
            NativeLocalization.ChineseLocale => new(
                "Microsoft YaHei UI",
                "今日",
                "暂无数据",
                "tokens",
                "打开仪表盘",
                "立即同步",
                "开机时启动",
                "在 GitHub 上 Star",
                "退出"),
            NativeLocalization.TraditionalChineseLocale => new(
                "Microsoft JhengHei UI",
                "今日",
                "暫無資料",
                "tokens",
                "開啟儀表盤",
                "立即同步",
                "開機時啟動",
                "在 GitHub 上 Star",
                "退出"),
            NativeLocalization.JapaneseLocale => new(
                "Yu Gothic UI",
                "今日",
                "データなし",
                "tokens",
                "ダッシュボードを開く",
                "今すぐ同期",
                "ログイン時に起動",
                "GitHub で Star",
                "終了"),
            NativeLocalization.KoreanLocale => new(
                "Malgun Gothic",
                "오늘",
                "데이터 없음",
                "tokens",
                "대시보드 열기",
                "지금 동기화",
                "로그인 시 실행",
                "GitHub에서 Star",
                "종료"),
            _ => new(
                "Segoe UI Variable Text",
                "Today",
                "No data",
                "tokens",
                "Open Dashboard",
                "Sync Now",
                "Launch at Startup",
                "Star on GitHub",
                "Quit"),
        };
    }
}
