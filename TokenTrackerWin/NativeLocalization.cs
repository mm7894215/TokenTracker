using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace TokenTrackerWin;

internal static partial class NativeLocalization
{
    public const string PreferenceKey = "tokentracker-locale";
    public const string SystemPreference = "system";
    public const string EnglishLocale = "en";
    public const string ChineseLocale = "zh-CN";
    public const string TraditionalChineseLocale = "zh-TW";
    public const string JapaneseLocale = "ja";
    public const string KoreanLocale = "ko";

    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTracker",
        "native-settings.json");

    public static string CurrentPreference => ReadStoredPreference() ?? SystemPreference;

    public static string CurrentResolvedLocale => ResolveLocale(CurrentPreference);

    public static string NormalizePreference(string? value)
    {
        var raw = (value ?? "").Trim();
        if (raw.Length == 0) return SystemPreference;
        if (raw.Equals(SystemPreference, StringComparison.OrdinalIgnoreCase)) return SystemPreference;
        return Classify(raw);
    }

    public static string ResolveLocale(string? preference)
    {
        var normalized = NormalizePreference(preference);
        if (normalized != SystemPreference) return normalized;

        var primary = CultureInfo.CurrentCulture.Name;
        if (string.IsNullOrWhiteSpace(primary))
        {
            primary = CultureInfo.CurrentUICulture.Name;
        }
        return Classify(primary);
    }

    public static void StorePreference(string? value)
    {
        var normalized = NormalizePreference(value);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            var settings = ReadSettingsObject();
            settings["Locale"] = normalized;
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
            return settings?["Locale"]?.GetValue<string>() is { Length: > 0 } locale
                ? NormalizePreference(locale)
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

    private static string Classify(string tag)
    {
        if (ZhRegex().IsMatch(tag))
        {
            return TraditionalZhRegex().IsMatch(tag) ? TraditionalChineseLocale : ChineseLocale;
        }
        if (JaRegex().IsMatch(tag)) return JapaneseLocale;
        if (KoRegex().IsMatch(tag)) return KoreanLocale;
        return EnglishLocale;
    }

    [GeneratedRegex(@"^zh([-_]|$)", RegexOptions.IgnoreCase)]
    private static partial Regex ZhRegex();

    [GeneratedRegex(@"^zh[-_](hant|tw|hk|mo)([-_]|$)", RegexOptions.IgnoreCase)]
    private static partial Regex TraditionalZhRegex();

    [GeneratedRegex(@"^ja([-_]|$)", RegexOptions.IgnoreCase)]
    private static partial Regex JaRegex();

    [GeneratedRegex(@"^ko([-_]|$)", RegexOptions.IgnoreCase)]
    private static partial Regex KoRegex();
}
