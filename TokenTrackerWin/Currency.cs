namespace TokenTrackerWin;

/// <summary>
/// Mirror of the dashboard's <c>lib/currency.ts</c> symbol + default-rate table.
/// The tray reads the user's chosen currency (and live rates) from the WebView's
/// localStorage; these are the fallbacks when a rate is missing.
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
}
