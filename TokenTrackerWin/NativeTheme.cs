using System.IO;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace TokenTrackerWin;

internal static class NativeTheme
{
    public const string PreferenceKey = "tokentracker-theme";
    public const string SystemPreference = "system";
    public const string LightPreference = "light";
    public const string DarkPreference = "dark";

    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTracker",
        "native-settings.json");

    public static string CurrentPreference => ReadStoredPreference() ?? DarkPreference;

    public static string NormalizePreference(string? value)
    {
        var raw = (value ?? "").Trim().ToLowerInvariant();
        return raw switch
        {
            LightPreference => LightPreference,
            DarkPreference => DarkPreference,
            SystemPreference => SystemPreference,
            _ => DarkPreference,
        };
    }

    public static bool ResolveIsLight(string? preference)
    {
        return NormalizePreference(preference) switch
        {
            LightPreference => true,
            DarkPreference => false,
            _ => IsWindowsAppLightTheme(),
        };
    }

    public static void StorePreference(string? value)
    {
        var normalized = NormalizePreference(value);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            var settings = ReadSettingsObject();
            settings["Theme"] = normalized;
            File.WriteAllText(SettingsPath, settings.ToJsonString());
        }
        catch { /* best-effort native preference cache */ }
    }

    private static string? ReadStoredPreference()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return null;
            var settings = JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject();
            return settings?["Theme"]?.GetValue<string>() is { Length: > 0 } theme
                ? NormalizePreference(theme)
                : null;
        }
        catch
        {
            return null;
        }
    }

    private static JsonObject ReadSettingsObject()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return new JsonObject();
            return JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject() ?? new JsonObject();
        }
        catch
        {
            return new JsonObject();
        }
    }

    private static bool IsWindowsAppLightTheme()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return (key?.GetValue("AppsUseLightTheme") as int?) == 1;
        }
        catch
        {
            return false;
        }
    }
}
