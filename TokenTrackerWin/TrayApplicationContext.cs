using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using Microsoft.Win32;

namespace TokenTrackerWin;

/// <summary>
/// The resident tray controller — Windows counterpart of
/// <c>StatusBarController.swift</c>. Owns the NotifyIcon, the right-click menu,
/// the server lifecycle, the usage poller and the (lazily created) dashboard window.
/// </summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly System.Windows.Threading.Dispatcher _uiDispatcher =
        System.Windows.Application.Current?.Dispatcher
        ?? System.Windows.Threading.Dispatcher.CurrentDispatcher;
    private readonly NotifyIcon _trayIcon;
    private readonly ServerManager _server = new();
    private readonly UsagePoller _poller;
    private DashboardWindow? _dashboard;

    private readonly ContextMenuStrip _menu;
    private readonly TrayMenuRenderer _menuRenderer;
    private readonly ToolStripMenuItem _summaryItem;
    private readonly ToolStripMenuItem _openDashboardItem;
    private readonly ToolStripMenuItem _syncItem;
    private readonly ToolStripMenuItem _startupItem;
    private readonly ToolStripMenuItem _starItem;
    private readonly ToolStripMenuItem _quitItem;

    private UsagePoller.UsageStats? _lastStats;
    private string _localePreference = NativeLocalization.CurrentPreference;
    private string _themePreference = NativeTheme.CurrentPreference;
    private TrayStrings _strings = TrayStrings.For(NativeLocalization.CurrentResolvedLocale);
    private TrayMenuRenderer.Palette _menuPalette =
        TrayMenuRenderer.PaletteFor(NativeTheme.ResolveIsLight(NativeTheme.CurrentPreference));
    private Font? _menuFont;
    private Font? _summaryFont;

    // Lightweight UI-thread tick so the tooltip follows a currency change within a
    // couple of seconds without needing a right-click. Cheap: it only touches the
    // WebView (to read the currency) once the dashboard has been opened.
    private readonly System.Windows.Forms.Timer _refreshTimer = new() { Interval = 2000 };
    private readonly System.Windows.Forms.Timer _syncTimer = new() { Interval = 5 * 60 * 1000 };

    public TrayApplicationContext(bool showDashboardOnLaunch = false)
    {
        _poller = new UsagePoller(() => _server.BaseUrl);
        _menuRenderer = new TrayMenuRenderer(_menuPalette);

        _summaryItem = CreateMenuItem("", (_, _) => OpenDashboard());
        _openDashboardItem = CreateMenuItem("", (_, _) => OpenDashboard());
        _syncItem = CreateMenuItem("", (_, _) => _server.TriggerSync());
        _startupItem = CreateMenuItem("", OnToggleStartup);
        _startupItem.Checked = LaunchAtStartup.IsEnabled;
        _startupItem.CheckOnClick = false;
        _starItem = CreateMenuItem("", (_, _) => OpenInBrowser(Constants.GitHubUrl));
        _quitItem = CreateMenuItem("", (_, _) => Quit());

        _menu = new ContextMenuStrip
        {
            AllowTransparency = true,
            DropShadowEnabled = false,
            Renderer = _menuRenderer,
            BackColor = _menuPalette.MenuBackground,
            ForeColor = _menuPalette.Text,
            Padding = new Padding(6),
            ShowCheckMargin = true,
            ShowImageMargin = false,
        };
        _menu.Items.Add(_summaryItem);
        _menu.Items.Add(CreateSeparator());
        _menu.Items.Add(_openDashboardItem);
        _menu.Items.Add(_syncItem);
        _menu.Items.Add(CreateSeparator());
        _menu.Items.Add(_startupItem);
        _menu.Items.Add(_starItem);
        _menu.Items.Add(CreateSeparator());
        _menu.Items.Add(_quitItem);
        ApplyLocaleToMenu();
        _menu.Opened += (_, _) => TrayMenuRenderer.ApplyRoundedRegion(_menu);
        _menu.SizeChanged += (_, _) => TrayMenuRenderer.ApplyRoundedRegion(_menu);

        // Re-read the currency every time the menu opens so the cost is always
        // current (belt-and-suspenders alongside the WebView change notification).
        _menu.Opening += (_, _) =>
        {
            RefreshThemeFromDashboard();
            RefreshLocaleFromDashboard();
            RefreshSummary();
        };

        _trayIcon = new NotifyIcon
        {
            Icon = LoadTrayIcon(),
            Text = Constants.AppDisplayName,   // tooltip (≤63 chars)
            Visible = true,
            ContextMenuStrip = _menu,
        };
        // Left-click toggles the dashboard, matching the macOS popover.
        _trayIcon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) ToggleDashboard();
        };

        _server.StatusChanged += OnServerStatusChanged;
        _server.SyncCompleted += OnSyncCompleted;
        _poller.StatsUpdated += OnStatsUpdated;
        _refreshTimer.Tick += (_, _) => RefreshSummary();
        _syncTimer.Tick += (_, _) => TriggerBackgroundSync();
        _refreshTimer.Start();
        _ = _server.EnsureServerRunningAsync();

        // Open the dashboard window for a normal launch. Deferred onto the dispatcher so
        // it shows once the message pump is running; the WebView navigates itself when the
        // server + WebView core are both ready (it tolerates being shown before then).
        if (showDashboardOnLaunch)
            _uiDispatcher.BeginInvoke(new Action(OpenDashboard));
    }

    private ToolStripMenuItem CreateMenuItem(string text, EventHandler onClick)
    {
        return new ToolStripMenuItem(text, null, onClick)
        {
            BackColor = _menuPalette.MenuBackground,
            ForeColor = _menuPalette.Text,
            Margin = new Padding(0, 1, 0, 1),
            Padding = new Padding(10, 6, 16, 6),
        };
    }

    private ToolStripSeparator CreateSeparator()
    {
        return new ToolStripSeparator
        {
            BackColor = _menuPalette.MenuBackground,
            ForeColor = _menuPalette.Separator,
            Margin = new Padding(0, 4, 0, 4),
        };
    }

    private void ApplyLocaleToMenu()
    {
        _strings = TrayStrings.For(NativeLocalization.ResolveLocale(_localePreference));

        _menuFont?.Dispose();
        _summaryFont?.Dispose();
        _menuFont = new Font(_strings.FontFamily, 9.5f, FontStyle.Regular, GraphicsUnit.Point);
        _summaryFont = new Font(_strings.FontFamily, 9.5f, FontStyle.Bold, GraphicsUnit.Point);

        _menu.Font = _menuFont;
        _summaryItem.Font = _summaryFont;
        _summaryItem.Text = $"{_strings.TodayTitle}: {_strings.NoData}";
        _openDashboardItem.Text = _strings.OpenDashboard;
        _syncItem.Text = _strings.SyncNow;
        _startupItem.Text = _strings.LaunchAtLogin;
        _starItem.Text = _strings.StarOnGitHub;
        _quitItem.Text = _strings.Quit;

        ApplyThemeToMenu();

        RefreshSummary();
    }

    private void ApplyThemeToMenu()
    {
        _menuRenderer.SetPalette(_menuPalette);
        _menu.BackColor = _menuPalette.MenuBackground;
        _menu.ForeColor = _menuPalette.Text;

        foreach (ToolStripItem item in _menu.Items)
        {
            item.BackColor = _menuPalette.MenuBackground;
            item.ForeColor = item is ToolStripSeparator
                ? _menuPalette.Separator
                : item.Enabled ? _menuPalette.Text : _menuPalette.DisabledText;
        }

        _menu.Invalidate(true);
    }

    private void ApplyThemePreference(string preference)
    {
        var normalized = NativeTheme.NormalizePreference(preference);
        var nextPalette = TrayMenuRenderer.PaletteFor(NativeTheme.ResolveIsLight(normalized));
        if (_themePreference == normalized && _menuPalette == nextPalette) return;

        _themePreference = normalized;
        _menuPalette = nextPalette;
        NativeTheme.StorePreference(normalized);
        ApplyThemeToMenu();
    }

    private async void RefreshThemeFromDashboard()
    {
        var preference = _dashboard is not null
            ? await _dashboard.ReadThemePreferenceAsync()
            : NativeTheme.CurrentPreference;
        ApplyThemePreference(preference);
    }

    private async void RefreshLocaleFromDashboard()
    {
        var preference = _dashboard is not null
            ? await _dashboard.ReadLocalePreferenceAsync()
            : NativeLocalization.CurrentPreference;
        preference = NativeLocalization.NormalizePreference(preference);
        if (_localePreference == preference) return;

        _localePreference = preference;
        NativeLocalization.StorePreference(preference);
        ApplyLocaleToMenu();
    }

    private void OpenDashboard()
    {
        EnsureDashboard();
        _dashboard!.ShowDashboard();
    }

    private void ToggleDashboard()
    {
        EnsureDashboard();
        _dashboard!.ToggleDashboard();
    }

    private void EnsureDashboard()
    {
        if (_dashboard is not null) return;
        _dashboard = new DashboardWindow(_server);
        // Re-render the cost when the dashboard reports a currency change (and once
        // it has loaded, so we pick up the user's chosen currency right away).
        _dashboard.CurrencyChanged += () => PostToUi(RefreshSummary);
        _dashboard.LocaleChanged += () => PostToUi(RefreshLocaleFromDashboard);
        _dashboard.ThemeChanged += () => PostToUi(RefreshThemeFromDashboard);
    }

    /// <summary>
    /// Handle a <c>tokentracker://</c> deep link (forwarded from a second launch, or a
    /// cold start argument). Currently only the OAuth callback
    /// <c>tokentracker://auth/callback?insforge_code=…</c> is used; the code is routed
    /// into the dashboard WebView to finish the InsForge session exchange. Mirrors the
    /// macOS <c>application(_:open:)</c> → <c>handleAuthCallback</c> path.
    /// </summary>
    public void HandleDeepLink(string url)
    {
        DiagLog($"HandleDeepLink url={url}");
        string? code = null;
        try
        {
            var uri = new Uri(url);
            if (!uri.Host.Equals("auth", StringComparison.OrdinalIgnoreCase)) return;
            foreach (var pair in uri.Query.TrimStart('?').Split('&'))
            {
                var i = pair.IndexOf('=');
                if (i <= 0 || pair[..i] != "insforge_code") continue;
                var raw = pair[(i + 1)..];
                if (raw.Length > 0) code = Uri.UnescapeDataString(raw);
                break;
            }
        }
        catch { return; }

        if (string.IsNullOrEmpty(code)) { DiagLog("HandleDeepLink no insforge_code in query"); return; }
        var resolved = code;
        DiagLog($"HandleDeepLink resolved code.len={resolved.Length}");
        PostToUi(() =>
        {
            EnsureDashboard();
            _dashboard!.HandleAuthCallback(resolved);
        });
    }

    /// <summary>Diagnostics → %LOCALAPPDATA%\TokenTracker\windows-host.log (shared with ServerManager).</summary>
    private static void DiagLog(string message)
    {
        try
        {
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TokenTracker", "windows-host.log");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.AppendAllText(path, $"{DateTimeOffset.Now:O} [tray] {message}{Environment.NewLine}");
        }
        catch { /* best-effort diagnostics */ }
    }

    private void OnToggleStartup(object? sender, EventArgs e)
    {
        LaunchAtStartup.Toggle();
        _startupItem.Checked = LaunchAtStartup.IsEnabled;
    }

    private void OnServerStatusChanged(ServerManager.ServerStatus status)
    {
        PostToUi(() =>
        {
            if (status == ServerManager.ServerStatus.Running)
            {
                _poller.Start();   // begin (or resume) polling once the server answers
                _poller.RefreshNow();
                _syncTimer.Start();
                TriggerBackgroundSync();
            }
            else if (status == ServerManager.ServerStatus.Failed)
            {
                _syncTimer.Stop();
                var message = _server.LastError ?? "The local server stopped responding.";
                _trayIcon.ShowBalloonTip(5000, Constants.AppDisplayName, message, ToolTipIcon.Warning);
            }
        });
    }

    private void TriggerBackgroundSync()
    {
        if (_server.Status != ServerManager.ServerStatus.Running) return;
        _server.TriggerBackgroundSync();
    }

    private void OnSyncCompleted()
    {
        _poller.RefreshNow();
    }

    private void OnStatsUpdated(UsagePoller.UsageStats stats)
    {
        _lastStats = stats;
        PostToUi(RefreshSummary);
    }

    /// <summary>Render the today summary into the menu + tooltip, in the user's currency.</summary>
    private async void RefreshSummary()
    {
        if (_lastStats is not { } s)
        {
            _summaryItem.Text = $"{_strings.TodayTitle}: {_strings.NoData}";
            return;
        }

        // Convert USD → the dashboard's chosen currency (read from its localStorage).
        var (symbol, rate) = _dashboard is not null
            ? await _dashboard.ReadCurrencyAsync()
            : ("$", 1m);
        var cost = symbol + (s.TodayCostUsd * rate).ToString("0.00", CultureInfo.InvariantCulture);
        var text = s.TodayTokens <= 0
            ? $"{_strings.TodayTitle}: {_strings.NoData}"
            : $"{_strings.TodayTitle}: {UsagePoller.FormatTokens(s.TodayTokens)} {_strings.TokensUnit} · {cost}";

        _summaryItem.Text = text;
        // NotifyIcon.Text is capped at 63 chars; the summary fits comfortably.
        _trayIcon.Text = text.Length <= 63 ? text : text[..63];
        RefreshTrayIconForTheme();
    }

    private void PostToUi(Action action)
    {
        if (_uiDispatcher.HasShutdownStarted || _uiDispatcher.HasShutdownFinished) return;
        if (_uiDispatcher.CheckAccess())
        {
            action();
            return;
        }
        _uiDispatcher.BeginInvoke(action);
    }

    private static void OpenInBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { /* ignore */ }
    }

    // ── Tray icon (Clawd mascot, themed to the taskbar) ────────────────

    private bool? _lastIconLight;

    private Icon LoadTrayIcon()
    {
        _lastIconLight = IsTaskbarLight();
        return LoadMascotIcon(_lastIconLight.Value) ?? SystemIcons.Application;
    }

    /// <summary>Swap the mascot glyph if the taskbar light/dark theme changed.</summary>
    private void RefreshTrayIconForTheme()
    {
        bool light = IsTaskbarLight();
        if (_lastIconLight == light) return;
        var icon = LoadMascotIcon(light);
        if (icon is null) return;
        _lastIconLight = light;
        var old = _trayIcon.Icon;
        _trayIcon.Icon = icon;
        old?.Dispose();
    }

    private static Icon? LoadMascotIcon(bool taskbarLight)
    {
        // Light taskbar → dark glyph; dark taskbar → white glyph.
        var file = taskbarLight ? "tray-mascot-onLight.ico" : "tray-mascot-onDark.ico";
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "assets", file);
            if (File.Exists(path)) return new Icon(path);
        }
        catch { /* fall through */ }
        return null;
    }

    private static bool IsTaskbarLight()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            // SystemUsesLightTheme governs the taskbar/tray; 1 = light, 0/absent = dark.
            return (key?.GetValue("SystemUsesLightTheme") as int?) == 1;
        }
        catch
        {
            return false; // assume dark taskbar (Win11 default)
        }
    }

    private void Quit()
    {
        _refreshTimer.Stop();
        _syncTimer.Stop();
        _trayIcon.Visible = false;
        _poller.Dispose();
        _server.StopServer();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _refreshTimer.Dispose();
            _syncTimer.Dispose();
            _poller.Dispose();
            _server.Dispose();
            _trayIcon.Dispose();
            _menu.Dispose();
            _menuFont?.Dispose();
            _summaryFont?.Dispose();
            _dashboard?.Shutdown();   // WPF Window has no Dispose; really close it
        }
        base.Dispose(disposing);
    }
}
