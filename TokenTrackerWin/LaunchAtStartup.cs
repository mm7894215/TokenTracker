using Microsoft.Win32;

namespace TokenTrackerWin;

/// <summary>
/// Windows counterpart of <c>LaunchAtLoginManager.swift</c>. Uses the per-user
/// HKCU Run key (no admin rights, no scheduled task) so toggling never elevates.
/// </summary>
internal static class LaunchAtStartup
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

    /// <summary>
    /// Passed on the auto-start command line so the app can tell a boot-time launch
    /// (stay quietly in the tray) from a manual launch (pop the dashboard open).
    /// </summary>
    public const string StartupArgument = "--startup";

    private static string ExecutablePath =>
        Environment.ProcessPath ?? Application.ExecutablePath;

    public static bool IsEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
            var value = key?.GetValue(Constants.StartupRegistryValueName) as string;
            if (string.IsNullOrEmpty(value)) return false;
            // Only consider it "on" if the registered command still points at this exe
            // (the value also carries the StartupArgument, so match on the path itself).
            return value.IndexOf(ExecutablePath, StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }

    public static void Enable()
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
        // Quote the path so spaces in the install dir don't split the command, and tag
        // the launch so we start minimized to the tray instead of popping the window.
        key?.SetValue(Constants.StartupRegistryValueName, $"\"{ExecutablePath}\" {StartupArgument}");
    }

    public static void Disable()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
        if (key?.GetValue(Constants.StartupRegistryValueName) is not null)
            key.DeleteValue(Constants.StartupRegistryValueName, throwOnMissingValue: false);
    }

    public static void Toggle()
    {
        if (IsEnabled) Disable();
        else Enable();
    }
}
