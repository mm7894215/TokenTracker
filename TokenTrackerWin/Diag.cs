using System.IO;

namespace TokenTrackerWin;

/// <summary>
/// Best-effort diagnostics to %LOCALAPPDATA%\TokenTracker\windows-host.log (shared with
/// ServerManager / DashboardWindow / TrayApplicationContext). Never throws.
/// </summary>
internal static class Diag
{
    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTracker", "windows-host.log");

    public static void Log(string component, string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            File.AppendAllText(LogPath, $"{DateTimeOffset.Now:O} [{component}] {message}{Environment.NewLine}");
        }
        catch { /* best-effort */ }
    }
}
