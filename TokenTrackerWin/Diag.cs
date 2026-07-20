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

    // Serializes the per-line writers (node stdout/stderr arrive on pipe-drain
    // pool threads) so the rotation below can't move the file mid-append.
    private static readonly object LogLock = new();
    private static bool _directoryEnsured;

    /// Past this size the log rotates to windows-host.log.old (one generation kept).
    /// The file previously grew unbounded — every node stdout/stderr line is logged.
    private const long MaxLogBytes = 1_000_000;

    public static void Log(string component, string message)
    {
        try
        {
            lock (LogLock)
            {
                if (!_directoryEnsured)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
                    _directoryEnsured = true;
                }
                try
                {
                    if (File.Exists(LogPath) && new FileInfo(LogPath).Length > MaxLogBytes)
                    {
                        File.Move(LogPath, LogPath + ".old", overwrite: true);
                    }
                }
                catch { /* rotation is best-effort; still append below */ }
                File.AppendAllText(LogPath, $"{DateTimeOffset.Now:O} [{component}] {message}{Environment.NewLine}");
            }
        }
        catch { /* best-effort */ }
    }
}
