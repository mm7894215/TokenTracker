using Microsoft.Win32;

namespace TokenTrackerWin;

/// <summary>
/// Windows counterpart of <c>LaunchAtLoginManager.swift</c>. Uses the per-user
/// HKCU Run key (no admin rights, no scheduled task) so toggling never elevates.
/// </summary>
internal static class LaunchAtStartup
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

    private static string ExecutablePath =>
        Environment.ProcessPath ?? Application.ExecutablePath;

    public static bool IsEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
            var value = key?.GetValue(Constants.StartupRegistryValueName) as string;
            if (string.IsNullOrEmpty(value)) return false;
            // Only consider it "on" if the registered path still points at this exe.
            return string.Equals(
                value.Trim('"'),
                ExecutablePath,
                StringComparison.OrdinalIgnoreCase);
        }
    }

    public static void Enable()
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
        // Quote the path so spaces in the install dir don't split the command.
        key?.SetValue(Constants.StartupRegistryValueName, $"\"{ExecutablePath}\"");
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
