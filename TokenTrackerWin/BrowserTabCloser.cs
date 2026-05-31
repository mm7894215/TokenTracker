using System.Diagnostics;
using System.Runtime.InteropServices;

namespace TokenTrackerWin;

/// <summary>
/// Best-effort cleanup for the system-browser OAuth callback tab.
///
/// Browsers normally refuse `window.close()` for tabs they did not open by script,
/// so the native app closes the callback tab after it receives the tokentracker://
/// deep link. The implementation only closes a tab whose address bar is exactly on
/// this app's local /auth/callback route.
/// </summary>
internal static class BrowserTabCloser
{
    private static readonly string[] BrowserProcessNames =
    {
        "chrome",
        "msedge",
        "firefox",
        "brave",
        "opera",
        "vivaldi",
    };

    public static void CloseAuthCallbackTab(string localBaseUrl, nint appWindowHandle)
    {
        var thread = new Thread(() =>
        {
            try
            {
                Thread.Sleep(450);
                CloseAuthCallbackTabOnSta(localBaseUrl, appWindowHandle);
            }
            catch (Exception ex)
            {
                Diag.Log("browser", $"callback tab cleanup failed: {ex.GetType().Name}");
            }
        })
        {
            IsBackground = true,
            Name = "TokenTracker OAuth tab cleanup",
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    private static void CloseAuthCallbackTabOnSta(string localBaseUrl, nint appWindowHandle)
    {
        if (!Uri.TryCreate(localBaseUrl, UriKind.Absolute, out var baseUri)) return;

        System.Windows.Forms.IDataObject? previousClipboard = null;
        try { previousClipboard = System.Windows.Forms.Clipboard.GetDataObject(); }
        catch { /* clipboard can be temporarily locked by another process */ }

        try
        {
            foreach (var hwnd in BrowserWindowHandles())
            {
                if (TryCloseCallbackTab(hwnd, baseUri))
                {
                    Diag.Log("browser", "closed auth callback tab");
                    RestoreAppWindow(appWindowHandle);
                    return;
                }
            }

            Diag.Log("browser", "auth callback tab not found");
        }
        finally
        {
            if (previousClipboard is not null)
            {
                try { System.Windows.Forms.Clipboard.SetDataObject(previousClipboard, true); }
                catch { /* best-effort clipboard restoration */ }
            }
            RestoreAppWindow(appWindowHandle);
        }
    }

    private static IEnumerable<nint> BrowserWindowHandles()
    {
        var seen = new HashSet<nint>();
        foreach (var name in BrowserProcessNames)
        {
            Process[] processes;
            try { processes = Process.GetProcessesByName(name); }
            catch { continue; }

            foreach (var process in processes)
            {
                using (process)
                {
                    nint hwnd;
                    try { hwnd = process.MainWindowHandle; }
                    catch { continue; }
                    if (hwnd == 0 || !seen.Add(hwnd)) continue;
                    yield return hwnd;
                }
            }
        }
    }

    private static bool TryCloseCallbackTab(nint hwnd, Uri baseUri)
    {
        BringWindowForwardPreservingState(hwnd);
        SetForegroundWindow(hwnd);
        Thread.Sleep(180);

        const int maxTabsToScan = 24;
        for (var i = 0; i < maxTabsToScan; i++)
        {
            var address = CopyAddressBarText();
            if (IsAuthCallbackUrl(address, baseUri))
            {
                System.Windows.Forms.SendKeys.SendWait("^w");
                Thread.Sleep(150);
                return true;
            }

            System.Windows.Forms.SendKeys.SendWait("^{TAB}");
            Thread.Sleep(110);
        }
        return false;
    }

    private static string CopyAddressBarText()
    {
        try
        {
            System.Windows.Forms.SendKeys.SendWait("^l");
            Thread.Sleep(70);
            System.Windows.Forms.SendKeys.SendWait("^c");
            Thread.Sleep(90);
            return System.Windows.Forms.Clipboard.ContainsText()
                ? System.Windows.Forms.Clipboard.GetText()
                : "";
        }
        catch
        {
            return "";
        }
    }

    private static bool IsAuthCallbackUrl(string address, Uri baseUri)
    {
        if (!Uri.TryCreate(address.Trim(), UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme != "http") return false;
        if (uri.Port != baseUri.Port) return false;
        if (!uri.Host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)
            && !uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
            return false;

        return uri.AbsolutePath.Equals("/auth/callback", StringComparison.OrdinalIgnoreCase)
            || uri.AbsolutePath.Equals("/auth/native-callback", StringComparison.OrdinalIgnoreCase);
    }

    private static void RestoreAppWindow(nint appWindowHandle)
    {
        if (appWindowHandle == 0) return;
        BringWindowForwardPreservingState(appWindowHandle);
        SetForegroundWindow(appWindowHandle);
    }

    private static void BringWindowForwardPreservingState(nint hwnd)
    {
        if (hwnd == 0) return;
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    }

    private const int SW_RESTORE = 9;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(nint hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(nint hWnd);
}
