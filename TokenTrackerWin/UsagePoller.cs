using System.Globalization;
using System.Net.Http;
using System.Text.Json;

namespace TokenTrackerWin;

/// <summary>
/// Polls the local server's usage-summary endpoint for today's totals so the
/// tray can show "Today &lt;tokens&gt; · &lt;cost&gt;" (the Windows stand-in for the
/// macOS menu-bar stat display — the tray can't render inline text, so the
/// numbers surface in the tooltip + menu header).
/// </summary>
internal sealed class UsagePoller : IDisposable
{
    public readonly record struct UsageStats(long TodayTokens, decimal TodayCostUsd);

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(6) };
    private readonly Func<string> _baseUrl;
    private CancellationTokenSource? _cts;

    /// <summary>Raised on the thread-pool with fresh stats. UI must marshal to the UI thread.</summary>
    public event Action<UsageStats>? StatsUpdated;

    public UsagePoller(Func<string> baseUrl) => _baseUrl = baseUrl;

    public void Start()
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        var token = _cts.Token;
        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                var stats = await FetchAsync();
                if (stats is { } s && !token.IsCancellationRequested) StatsUpdated?.Invoke(s);
                try { await Task.Delay(TimeSpan.FromSeconds(60), token); }
                catch (TaskCanceledException) { break; }
            }
        }, token);
    }

    public void RefreshNow()
    {
        var token = _cts?.Token ?? CancellationToken.None;
        _ = Task.Run(async () =>
        {
            var stats = await FetchAsync();
            if (stats is { } s && !token.IsCancellationRequested) StatsUpdated?.Invoke(s);
        }, token);
    }

    private async Task<UsageStats?> FetchAsync()
    {
        try
        {
            var today = DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var offsetMin = (int)DateTimeOffset.Now.Offset.TotalMinutes;
            var tz = ResolveIanaTimeZone();
            var url = $"{_baseUrl()}/functions/tokentracker-usage-summary"
                      + $"?from={today}&to={today}&tz={Uri.EscapeDataString(tz)}"
                      + $"&tz_offset_minutes={offsetMin}";

            using var resp = await Http.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return null;

            await using var stream = await resp.Content.ReadAsStreamAsync();
            using var doc = await JsonDocument.ParseAsync(stream);
            if (!doc.RootElement.TryGetProperty("totals", out var totals)) return null;

            long tokens = totals.TryGetProperty("total_tokens", out var t)
                ? t.GetInt64() : 0;
            decimal cost = 0m;
            if (totals.TryGetProperty("total_cost_usd", out var c)
                && decimal.TryParse(c.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed))
                cost = parsed;

            return new UsageStats(tokens, cost);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>The endpoint expects an IANA tz; Windows uses its own ids, so convert.</summary>
    private static string ResolveIanaTimeZone()
    {
        try
        {
            if (TimeZoneInfo.TryConvertWindowsIdToIanaId(TimeZoneInfo.Local.Id, out var iana))
                return iana;
        }
        catch { /* fall back below */ }
        return "UTC";
    }

    public void Dispose()
    {
        _cts?.Cancel();
        _cts = null;
    }

    // ── Formatting (mirrors macOS TokenFormatter.formatCompact + cost) ──

    public static string FormatTokens(long n)
    {
        if (n >= 1_000_000_000) return (n / 1_000_000_000d).ToString("0.0", CultureInfo.InvariantCulture) + "B";
        if (n >= 1_000_000) return (n / 1_000_000d).ToString("0.0", CultureInfo.InvariantCulture) + "M";
        if (n >= 1_000) return (n / 1_000d).ToString("0.0", CultureInfo.InvariantCulture) + "K";
        return n.ToString(CultureInfo.InvariantCulture);
    }

    public static string FormatCost(decimal usd) =>
        "$" + usd.ToString("0.00", CultureInfo.InvariantCulture);
}
