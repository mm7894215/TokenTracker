using System.IO;
using System.Text.Json.Nodes;

namespace TokenTrackerWin;

/// <summary>
/// Mirror of the dashboard's <c>lib/currency.ts</c> symbol + default-rate table.
/// The tray reads the user's chosen currency (and live rates) from the WebView's
/// localStorage; these are the fallbacks when a rate is missing.
///
/// The chosen symbol + rate are also cached natively (native-settings.json, alongside
/// the locale/theme prefs) so the floating pet can show the right currency on a cold
/// launch — when only the pet is on screen and the dashboard WebView (the live source)
/// hasn't been created yet, there'd otherwise be nothing to read and the pet would fall
/// back to USD even though the app last ran in, say, CNY.
/// </summary>
internal static class Currency
{
    private static readonly Dictionary<string, (string Symbol, decimal DefaultRate)> Map =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["USD"] = ("$", 1m),
            ["EUR"] = ("€", 0.92m),
            ["GBP"] = ("£", 0.79m),
            ["CNY"] = ("¥", 7.2m),
            ["JPY"] = ("¥", 155m),
            ["HKD"] = ("HK$", 7.8m),
        };

    public static string Symbol(string? code) =>
        code is not null && Map.TryGetValue(code, out var m) ? m.Symbol : "$";

    public static decimal DefaultRate(string? code) =>
        code is not null && Map.TryGetValue(code, out var m) ? m.DefaultRate : 1m;

    // ── Native cache (native-settings.json) ────────────────────────────

    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTracker",
        "native-settings.json");

    /// <summary>Cache the live currency symbol + USD→currency rate so a cold-launched pet
    /// matches the app's last-used unit before the dashboard WebView exists.</summary>
    public static void Persist(string symbol, decimal rate)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            var settings = ReadSettingsObject();
            settings["CurrencySymbol"] = symbol;
            settings["CurrencyRate"] = JsonValue.Create(rate);
            File.WriteAllText(SettingsPath, settings.ToJsonString());
        }
        catch { /* best-effort native cache */ }
    }

    /// <summary>The last cached (symbol, rate), or null if none has been stored yet.</summary>
    public static (string Symbol, decimal Rate)? ReadPersisted()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return null;
            var settings = JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject();
            if (settings?["CurrencySymbol"]?.GetValue<string>() is not { Length: > 0 } symbol) return null;
            var rate = settings["CurrencyRate"]?.GetValue<decimal>() ?? 1m;
            return (symbol, rate > 0 ? rate : 1m);
        }
        catch { return null; }
    }

    private static JsonObject ReadSettingsObject()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return new JsonObject();
            return JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject() ?? new JsonObject();
        }
        catch { return new JsonObject(); }
    }
}
