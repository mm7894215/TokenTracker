using Microsoft.Win32;

namespace TokenTrackerWin;

/// <summary>
/// Registers the <c>tokentracker://</c> URL scheme for the current user, so the OAuth
/// callback page (running in the system browser) can deep-link the auth code back into
/// this app — the Windows analogue of the macOS app's Info.plist
/// <c>CFBundleURLSchemes</c>. Per-user (HKCU\Software\Classes), so no admin rights are
/// needed and it never touches machine-wide state.
/// </summary>
internal static class UrlProtocol
{
    public const string Scheme = "tokentracker";

    /// <summary>
    /// Point <c>tokentracker://</c> at this executable. Idempotent and cheap, so we just
    /// run it every launch to self-heal if the exe moved. Best-effort: failures are
    /// swallowed (OAuth simply won't deep-link back; other features are unaffected).
    /// </summary>
    public static void EnsureRegistered()
    {
        try
        {
            var exe = Environment.ProcessPath;
            if (string.IsNullOrEmpty(exe)) return;

            var command = CommandLine(exe);
            // Already pointing at this exe? Skip the writes.
            using (var cmdRead = Registry.CurrentUser.OpenSubKey(
                $@"Software\Classes\{Scheme}\shell\open\command"))
            {
                if (cmdRead?.GetValue(null) as string == command) return;
            }

            using var key = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{Scheme}");
            key.SetValue(null, "URL:TokenTracker Protocol");
            key.SetValue("URL Protocol", "");
            using var cmd = key.CreateSubKey(@"shell\open\command");
            cmd.SetValue(null, command);
        }
        catch { /* registration is best-effort */ }
    }

    private static string CommandLine(string exe) => $"\"{exe}\" \"%1\"";
}
