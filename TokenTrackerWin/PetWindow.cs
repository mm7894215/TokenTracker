using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace TokenTrackerWin;

/// <summary>
/// A small, always-on-top floating widget showing ONLY the animated "Clawd"
/// companion — the Windows desktop counterpart of the mascot the macOS app shows
/// in its menu-bar popover (the taskbar can't host an animated icon, so we float
/// the sprite directly on the desktop).
///
/// Transparency: this is a WPF <b>layered</b> window (<see cref="Window.AllowsTransparency"/>
/// = true, <see cref="WindowStyle"/> = None, transparent background) hosting a
/// <see cref="WebView2CompositionControl"/> (DirectComposition / windowless). The
/// composition surface's per-pixel alpha is honoured by the layered window, so only
/// the sprite's opaque pixels show and everything around it is fully see-through to
/// the desktop — no frame, no frosted box.
///
/// There is no chrome: the whole surface is the hit area. The page decides what a
/// press means (<c>pet:drag</c> → native window move, tap → animation, right-click →
/// <c>pet:open-dashboard</c>). Closing hides the window; the app exits via the tray
/// "Quit" → <see cref="Shutdown"/>.
/// </summary>
internal sealed class PetWindow : Window
{
    // Windowless (DirectComposition) hosting — the only WPF WebView2 variant that
    // renders a genuinely transparent surface. AllowExternalDrop must be off
    // (windowless hosting throws on init otherwise).
    private readonly WebView2CompositionControl _webView = new() { AllowExternalDrop = false };
    private readonly ServerManager _server;
    private readonly System.Windows.Threading.DispatcherTimer _saveTimer;
    private readonly System.Windows.Threading.DispatcherTimer _hoverTimer;
    private bool _lastHover;
    private bool _typing;
    private long _lastKeyTick;
    private long _typingStreakStart;  // when the current unbroken typing streak began (0 = not typing)
    private long _rageUntil;          // TickCount until which the overheated "error" gag shows
    private bool _rage;
    private bool _coreReady;
    private bool _exiting;
    private nint _hwnd;
    private string _curSymbol = "$";
    private decimal _curRate = 1m;
    private string _locale = "en";
    private bool _syncing;
    private long _tokens;
    private decimal _costUsd;
    private bool _connected = true;

    /// <summary>Raised (on the UI thread) when the user right-clicks the pet — the host shows a context menu.</summary>
    public event Action? ContextMenuRequested;

    public PetWindow(ServerManager server)
    {
        _server = server;

        Title = Constants.AppDisplayName + " Pet";
        var (w, h) = SizeDimensions(CurrentSize);
        Width = w;
        Height = h;
        WindowStyle = WindowStyle.None;          // no OS chrome
        ResizeMode = ResizeMode.NoResize;
        // Per-pixel transparency: layered window whose alpha comes from the
        // (transparent) WebView2 composition surface. Must be set before the handle
        // is created — i.e. here in the constructor, before the window is shown.
        AllowsTransparency = true;
        Background = System.Windows.Media.Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;                   // floating — don't steal focus from the active app

        RestorePlacement();

        Content = _webView;

        // Persist the position shortly after a drag settles (LocationChanged fires
        // continuously during an OS move).
        _saveTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(500),
        };
        _saveTimer.Tick += (_, _) => { _saveTimer.Stop(); SavePlacement(); };
        LocationChanged += (_, _) => { _saveTimer.Stop(); _saveTimer.Start(); };

        // WebView2 does not reliably deliver mouse-leave to this transparent, never-
        // activated topmost window, so the page's own hover detection sticks. Poll the
        // OS cursor vs the window rect instead and push the hover state to the page.
        _hoverTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(150),
        };
        _hoverTimer.Tick += (_, _) => { HoverTick(); TypingTick(); };

        Loaded += async (_, _) => await InitializeWebViewAsync();
        _server.StatusChanged += OnServerStatusChanged;
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        _hwnd = new WindowInteropHelper(this).Handle;
    }

    private async Task InitializeWebViewAsync()
    {
        if (_coreReady) return;

        // Own user-data folder (separate from the dashboard's) so the two WebView2
        // environments never clash over differing creation options.
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "TokenTracker", "WebView2Pet");
        Directory.CreateDirectory(userDataFolder);

        // Transparent composition surface; must be set before the browser process starts.
        // Only alpha 0 (transparent) or 255 are supported.
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0");

        var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder, null);
        await _webView.EnsureCoreWebView2Async(env);
        _coreReady = true;

        _webView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0, 0, 0, 0);

        var core = _webView.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = false;

        // Keep the surface transparent even before the page's own CSS lands.
        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            "try{var s=document.createElement('style');" +
            "s.textContent='html,body,#pet-root{background:transparent!important}';" +
            "(document.head||document.documentElement).appendChild(s);}catch(e){}");

        core.WebMessageReceived += (_, e) =>
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); }
            catch { return; }

            switch (msg)
            {
                case "pet:drag":
                    // Hand the press off to the OS so the borderless window moves natively.
                    ReleaseCapture();
                    SendMessage(_hwnd, WM_NCLBUTTONDOWN, (nint)HTCAPTION, nint.Zero);
                    break;
                case "pet:context-menu":
                    ContextMenuRequested?.Invoke();
                    break;
            }
        };

        // Re-push currency + locale after every (re)load so the bubble + quips match
        // the app's unit/language even across navigations.
        core.NavigationCompleted += (_, _) => PushContext();

        NavigateWhenServerReady();
    }

    private void OnServerStatusChanged(ServerManager.ServerStatus status)
    {
        if (status != ServerManager.ServerStatus.Running) return;
        try { Dispatcher.BeginInvoke(new Action(NavigateWhenServerReady)); }
        catch { /* window is closing */ }
    }

    private void NavigateWhenServerReady()
    {
        if (!_coreReady || _server.Status != ServerManager.ServerStatus.Running) return;
        _webView.CoreWebView2.Navigate(_server.BaseUrl + "/pet.html?app=1");
    }

    // ── Public API ─────────────────────────────────────────────────────

    public void ShowPet()
    {
        if (!IsVisible) Show();
        Topmost = true;
        _hoverTimer.Start();
    }

    public void HidePet()
    {
        Hide();
        _hoverTimer.Stop();
        _lastHover = false;
        PushHover(false);
        _typing = false; // re-evaluated on next show
        _rage = false;
        _typingStreakStart = 0;
    }

    private void HoverTick()
    {
        if (!IsVisible || !_coreReady) return;
        if (!GetCursorPos(out var p)) return;
        bool inside;
        try
        {
            var tl = PointToScreen(new System.Windows.Point(0, 0));
            var br = PointToScreen(new System.Windows.Point(ActualWidth, ActualHeight));
            inside = p.X >= tl.X && p.X < br.X && p.Y >= tl.Y && p.Y < br.Y;
        }
        catch { return; }   // not laid out yet
        if (inside == _lastHover) return;
        _lastHover = inside;
        PushHover(inside);
    }

    private void PushHover(bool hovering)
    {
        if (!_coreReady) return;
        try
        {
            _ = _webView.CoreWebView2.ExecuteScriptAsync(
                $"window.__ttPetHover={(hovering ? "true" : "false")};" +
                "window.dispatchEvent(new Event('pet:hover'));");
        }
        catch { /* page mid-navigation */ }
    }

    // ── Typing activity (global, count-only) ───────────────────────────────
    //
    // Drives the "typing" animation while the user is actually typing — anywhere. We
    // poll a curated set of typing virtual-keys for "pressed since the previous call"
    // and only use that to reset a linger timer. This detects THAT the user is typing,
    // never WHICH keys (no content is read or stored), in line with the project's
    // token-counts-only privacy rule. Mouse buttons + modifiers are excluded so clicks
    // and Ctrl/Shift alone don't count.
    // Short enough that the animation stops ~immediately after you stop typing, but long
    // enough to bridge the all-keys-up gaps between keystrokes so it doesn't flicker mid-type.
    private const long TypingLingerMs = 400;
    // The overheat streak is more forgiving than the animation linger: a brief thinking
    // pause shouldn't reset your 30s of furious typing.
    private const long RageStreakGapMs = 1500;
    private const long RageTriggerMs = 30_000; // unbroken typing before Clawd "overheats"
    private const long RageShowMs = 5_000;     // how long the overheated "error" gag plays

    private void TypingTick()
    {
        long now = Environment.TickCount64;
        if (AnyTypingKeyPressed()) _lastKeyTick = now;
        long sinceKey = now - _lastKeyTick;
        bool typing = sinceKey < TypingLingerMs;

        if (typing != _typing) { _typing = typing; PushState("Typing", typing); }

        // Type non-stop for RageTriggerMs and Clawd overheats: it plays the "error" pose
        // (fanning itself / steaming) for RageShowMs, then resets — another full streak of
        // continuous typing is needed before it can trigger again.
        if (_rage)
        {
            if (now >= _rageUntil) { _rage = false; _typingStreakStart = 0; PushState("Rage", false); }
        }
        else if (sinceKey < RageStreakGapMs) // streak survives brief thinking pauses
        {
            if (_typingStreakStart == 0) _typingStreakStart = now;
            else if (now - _typingStreakStart >= RageTriggerMs)
            {
                _rage = true;
                _rageUntil = now + RageShowMs;
                PushState("Rage", true);
            }
        }
        else
        {
            _typingStreakStart = 0; // streak broken
        }
    }

    /// <summary>Set a boolean <c>window.__ttPet&lt;name&gt;</c> flag + dispatch <c>pet:&lt;name lower&gt;</c>.</summary>
    private void PushState(string name, bool value)
    {
        if (!_coreReady) return;
        try
        {
            _ = _webView.CoreWebView2.ExecuteScriptAsync(
                $"window.__ttPet{name}={(value ? "true" : "false")};" +
                $"window.dispatchEvent(new Event('pet:{name.ToLowerInvariant()}'));");
        }
        catch { /* page mid-navigation */ }
    }

    private static bool AnyTypingKeyPressed()
    {
        static bool Hit(int vk) => (GetAsyncKeyState(vk) & 0x0001) != 0; // pressed since last call
        for (int vk = 0x41; vk <= 0x5A; vk++) if (Hit(vk)) return true;  // A–Z
        for (int vk = 0x30; vk <= 0x39; vk++) if (Hit(vk)) return true;  // 0–9
        for (int vk = 0x60; vk <= 0x6F; vk++) if (Hit(vk)) return true;  // numpad 0–9 / operators
        foreach (int vk in TypingKeys) if (Hit(vk)) return true;
        return false;
    }

    // space, enter, backspace, tab, and the OEM punctuation keys (; = , - . / ` [ \ ] ').
    private static readonly int[] TypingKeys =
    {
        0x20, 0x0D, 0x08, 0x09,
        0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0,
        0xDB, 0xDC, 0xDD, 0xDE,
    };

    /// <summary>
    /// Push the resolved currency (symbol + USD→currency rate, read by the host
    /// from the dashboard) into the pet page so its hover bubble matches the app.
    /// </summary>
    public void ApplyCurrency(string symbol, decimal rate)
    {
        _curSymbol = string.IsNullOrEmpty(symbol) ? "$" : symbol;
        _curRate = rate > 0 ? rate : 1m;
        PushContext();
    }

    /// <summary>Push the resolved UI locale so the pet's tap quips match the app's language.</summary>
    public void ApplyLocale(string locale)
    {
        _locale = string.IsNullOrWhiteSpace(locale) ? "en" : locale;
        PushContext();
    }

    /// <summary>Push whether a sync is in progress (drives the "typing" animation, like macOS).</summary>
    public void ApplySyncing(bool syncing)
    {
        _syncing = syncing;
        PushContext();
    }

    /// <summary>
    /// Push today's usage (the SAME numbers the tray's UsagePoller fetched) so the
    /// pet's bubble + animation tier always match the tray exactly — no independent
    /// polling, no drift.
    /// </summary>
    public void ApplyUsage(long tokens, decimal costUsd)
    {
        _tokens = tokens;
        _costUsd = costUsd;
        PushContext();
    }

    /// <summary>Push whether the local server is reachable (drives the disconnected animation).</summary>
    public void ApplyConnected(bool connected)
    {
        _connected = connected;
        PushContext();
    }

    private void PushContext()
    {
        if (!_coreReady) return;
        var sym = System.Text.Json.JsonSerializer.Serialize(_curSymbol);
        var rate = _curRate.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var loc = System.Text.Json.JsonSerializer.Serialize(_locale);
        var syncing = _syncing ? "true" : "false";
        var cost = _costUsd.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var connected = _connected ? "true" : "false";
        try
        {
            _ = _webView.CoreWebView2.ExecuteScriptAsync(
                $"window.__ttPetCurrency={{symbol:{sym},rate:{rate}}};" +
                $"window.__ttPetLocale={loc};" +
                $"window.__ttPetSyncing={syncing};" +
                $"window.__ttPetTokens={_tokens};" +
                $"window.__ttPetCostUsd={cost};" +
                $"window.__ttPetConnected={connected};" +
                "window.dispatchEvent(new Event('pet:currency'));" +
                "window.dispatchEvent(new Event('pet:locale'));" +
                "window.dispatchEvent(new Event('pet:syncing'));" +
                "window.dispatchEvent(new Event('pet:usage'));" +
                "window.dispatchEvent(new Event('pet:connected'));");
        }
        catch { /* page mid-navigation */ }
    }

    /// <summary>Resize the floating pet (small / medium / large) live + persist the choice.</summary>
    public void ApplySize(string size)
    {
        var normalized = NormalizeSize(size);
        var (w, h) = SizeDimensions(normalized);
        Width = w;
        Height = h;
        WriteSettings(s => s["PetSize"] = normalized);
    }

    /// <summary>Persist a size choice without a live window (used when the pet is closed).</summary>
    public static void PersistSize(string size)
    {
        var normalized = NormalizeSize(size);
        WriteSettings(s => s["PetSize"] = normalized);
    }

    public void TogglePet()
    {
        if (IsVisible) HidePet();
        else ShowPet();
    }

    /// <summary>Really close + tear down (called from the tray "Quit").</summary>
    public void Shutdown()
    {
        _exiting = true;
        Close();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        // Hide instead of close unless the app is exiting, so reopening is instant.
        if (!_exiting)
        {
            e.Cancel = true;
            HidePet();
            return;
        }
        SavePlacement();
        _saveTimer.Stop();
        _hoverTimer.Stop();
        _server.StatusChanged -= OnServerStatusChanged;
        base.OnClosing(e);
    }

    // ── Placement persistence (native-settings.json) ───────────────────

    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTracker", "native-settings.json");

    /// <summary>True if the pet was visible when the app last exited (restored on launch).</summary>
    public static bool WasVisible
    {
        get
        {
            try
            {
                if (!File.Exists(SettingsPath)) return false;
                var s = JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject();
                return s?["PetVisible"]?.GetValue<bool>() ?? false;
            }
            catch { return false; }
        }
    }

    public void StoreVisible(bool visible) => WriteSettings(s => s["PetVisible"] = visible);

    // ── Size (small / medium / large) ──────────────────────────────────
    //
    // Windows are a touch wider than tall so the hover bubble has room; the sprite
    // tracks the smaller (height) dimension.

    public const string SizeSmall = "small";
    public const string SizeMedium = "medium";
    public const string SizeLarge = "large";

    public static string NormalizeSize(string? value)
    {
        return (value ?? "").Trim().ToLowerInvariant() switch
        {
            SizeSmall => SizeSmall,
            SizeLarge => SizeLarge,
            _ => SizeMedium,
        };
    }

    // Height includes a ~28px top band reserved for the hover/quip bubble (pet.jsx
    // BUBBLE_BAND) so the bubble floats above Clawd instead of overlapping it.
    private static (double Width, double Height) SizeDimensions(string size) => size switch
    {
        SizeSmall => (140, 120),
        SizeLarge => (196, 176),
        _ => (164, 144),
    };

    /// <summary>The persisted size choice (defaults to medium).</summary>
    public static string CurrentSize
    {
        get
        {
            try
            {
                if (!File.Exists(SettingsPath)) return SizeMedium;
                var s = JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject();
                return NormalizeSize(s?["PetSize"]?.GetValue<string>());
            }
            catch { return SizeMedium; }
        }
    }

    private void RestorePlacement()
    {
        WindowStartupLocation = WindowStartupLocation.Manual;
        var wa = SystemParameters.WorkArea;
        double left = wa.Right - Width - 24;
        double top = wa.Bottom - Height - 24;

        try
        {
            if (File.Exists(SettingsPath)
                && JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject() is { } s
                && s["PetX"]?.GetValue<double>() is { } x
                && s["PetY"]?.GetValue<double>() is { } y
                && IsOnScreen(x, y))
            {
                left = x;
                top = y;
            }
        }
        catch { /* fall back to the default bottom-right anchor */ }

        Left = left;
        Top = top;
    }

    private void SavePlacement()
    {
        if (WindowState != WindowState.Normal) return;
        var x = Left;
        var y = Top;
        if (double.IsNaN(x) || double.IsNaN(y)) return;
        WriteSettings(s => { s["PetX"] = x; s["PetY"] = y; });
    }

    /// <summary>Keep the saved top-left within the virtual desktop (guards against a
    /// monitor that was unplugged since the last save).</summary>
    private static bool IsOnScreen(double x, double y)
    {
        double minX = SystemParameters.VirtualScreenLeft;
        double minY = SystemParameters.VirtualScreenTop;
        double maxX = minX + SystemParameters.VirtualScreenWidth;
        double maxY = minY + SystemParameters.VirtualScreenHeight;
        return x >= minX - 8 && y >= minY - 8 && x <= maxX - 32 && y <= maxY - 32;
    }

    private static void WriteSettings(Action<JsonObject> mutate)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            JsonObject settings;
            try
            {
                settings = File.Exists(SettingsPath)
                    ? JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject() ?? new JsonObject()
                    : new JsonObject();
            }
            catch { settings = new JsonObject(); }
            mutate(settings);
            File.WriteAllText(SettingsPath, settings.ToJsonString());
        }
        catch { /* best-effort placement cache */ }
    }

    // ── P/Invoke + constants ───────────────────────────────────────────

    private const int WM_NCLBUTTONDOWN = 0xA1;
    private const int HTCAPTION = 2;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern nint SendMessage(nint hWnd, int msg, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
}
