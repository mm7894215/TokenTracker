using System.Globalization;
using System.Net.Http;
using System.Text.Json;

namespace TokenTrackerWin;

/// <summary>
/// Polls the local server's usage endpoints for the figures the tray + floating pet
/// surface. The tray only needs today's totals ("Today &lt;tokens&gt; · &lt;cost&gt;"),
/// but the desktop pet mirrors the macOS companion's data-rich quip pool, so when the
/// pet is visible the poller also gathers the rolling / heatmap / top-model stats the
/// macOS <c>DashboardViewModel</c> feeds its <c>quipPool</c>.
///
/// The 7-day / 30-day rolling stats + today's conversation count come <b>free</b> from
/// the same usage-summary call the tray already makes (the endpoint returns a
/// <c>rolling</c> block). The heatmap (all-time active days) and model breakdown (top
/// models) need their own calls, so they are gated behind <see cref="IncludeRichStats"/>
/// — only fetched while the pet is on screen, never wasted when it's hidden.
/// </summary>
internal sealed class UsagePoller : IDisposable
{
    /// <summary>One of the pet's "top models" (name + share + provider), mirroring macOS TopModel.</summary>
    public readonly record struct TopModelStat(string Name, string Percent, string Source);

    public readonly record struct UsageStats(
        long TodayTokens,
        decimal TodayCostUsd,
        int TodayConversations,
        long Last7dTokens,
        int Last7dActiveDays,
        long Last30dTokens,
        long Last30dAvgPerDay,
        int StreakDays,
        int ActiveDaysAllTime,
        IReadOnlyList<TopModelStat> TopModels);

    // Local server only (127.0.0.1) — never route through a system/env proxy, or a
    // VPN/proxy user without a loopback bypass can't reach it (see ServerManager.Http).
    private static readonly HttpClient Http =
        new(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(6) };
    private static readonly IReadOnlyList<TopModelStat> NoModels = Array.Empty<TopModelStat>();
    // Cross-device ("account") aggregate request flag; the local server decides
    // whether to serve it (signed in + cloud sync on) or local data, keeping the
    // tray/pet figures aligned with the dashboard. Joined with an explicit '&'.
    private const string AccountQuery = "account=1";
    private readonly Func<string> _baseUrl;
    private CancellationTokenSource? _cts;

    /// <summary>
    /// When true, each poll also gathers the heatmap + model-breakdown stats the pet's
    /// quip pool uses (two extra calls). The tray sets this from the pet's visibility so
    /// the extra work only happens while the pet is on screen.
    /// </summary>
    public volatile bool IncludeRichStats;

    /// <summary>
    /// Whether the most recent summary fetch returned cross-device ("account view")
    /// data rather than local single-machine data. Mirrors the macOS APIClient's
    /// <c>accountViewActive</c>; driven by the <c>X-TokenTracker-Account-View</c>
    /// response header the local server sets.
    /// </summary>
    public volatile bool AccountViewActive;

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
            var tzQuery = TimeZoneQuery();

            // account=1 → the server serves the same cross-device aggregate the
            // dashboard shows when the user is signed in with cloud sync on, and
            // otherwise falls back to local single-machine data. Same response
            // schema either way, so parsing below is unchanged.
            var summaryUrl = $"{_baseUrl()}/functions/tokentracker-usage-summary"
                             + $"?from={today}&to={today}{tzQuery}&{AccountQuery}";

            using var resp = await Http.GetAsync(summaryUrl);
            if (!resp.IsSuccessStatusCode) return null;

            // Track whether the server served the cross-device aggregate or fell
            // back to local data, mirroring the macOS client.
            if (resp.Headers.TryGetValues("X-TokenTracker-Account-View", out var accountViewValues))
                AccountViewActive = accountViewValues.FirstOrDefault() == "1";

            await using var stream = await resp.Content.ReadAsStreamAsync();
            using var doc = await JsonDocument.ParseAsync(stream);
            var root = doc.RootElement;
            if (!root.TryGetProperty("totals", out var totals)) return null;

            long tokens = GetLong(totals, "total_tokens");
            int convos = (int)GetLong(totals, "conversation_count");
            decimal cost = 0m;
            if (totals.TryGetProperty("total_cost_usd", out var c)
                && decimal.TryParse(c.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed))
                cost = parsed;

            // 7-day / 30-day rolling stats ride along in the same response — no extra call.
            long l7Tokens = 0, l30Tokens = 0, l30Avg = 0;
            int l7Active = 0;
            if (root.TryGetProperty("rolling", out var rolling))
            {
                if (rolling.TryGetProperty("last_7d", out var l7))
                {
                    l7Active = (int)GetLong(l7, "active_days");
                    if (l7.TryGetProperty("totals", out var l7t)) l7Tokens = GetLong(l7t, "billable_total_tokens");
                }
                if (rolling.TryGetProperty("last_30d", out var l30))
                {
                    l30Avg = GetLong(l30, "avg_per_active_day");
                    if (l30.TryGetProperty("totals", out var l30t)) l30Tokens = GetLong(l30t, "billable_total_tokens");
                }
            }

            // Heatmap (all-time active days / streak) + top models only when the pet wants them.
            int streak = 0, activeAll = 0;
            IReadOnlyList<TopModelStat> models = NoModels;
            if (IncludeRichStats)
            {
                (streak, activeAll) = await FetchHeatmapAsync(tzQuery);
                models = await FetchTopModelsAsync(today, tzQuery);
            }

            return new UsageStats(
                tokens, cost, convos,
                l7Tokens, l7Active,
                l30Tokens, l30Avg,
                streak, activeAll,
                models);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Heatmap: all-time active days + current streak (streak is server-computed; the
    /// local server returns 0, matching how the macOS pet reads it against the same backend).</summary>
    private async Task<(int Streak, int ActiveDays)> FetchHeatmapAsync(string tzQuery)
    {
        try
        {
            var url = $"{_baseUrl()}/functions/tokentracker-usage-heatmap?weeks=52{tzQuery}&{AccountQuery}";
            using var resp = await Http.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return (0, 0);
            await using var stream = await resp.Content.ReadAsStreamAsync();
            using var doc = await JsonDocument.ParseAsync(stream);
            var root = doc.RootElement;
            return ((int)GetLong(root, "streak_days"), (int)GetLong(root, "active_days"));
        }
        catch { return (0, 0); }
    }

    /// <summary>
    /// Top models over the last 30 days — a faithful port of the macOS
    /// <c>DashboardViewModel.buildTopModels()</c>: dedupe by lowercased model name, keep the
    /// provider from the highest-token row for that name, percent = tokens / total billable
    /// (one decimal), sort by tokens desc then name asc, top 5.
    /// </summary>
    private async Task<IReadOnlyList<TopModelStat>> FetchTopModelsAsync(string today, string tzQuery)
    {
        try
        {
            var from = DateTime.Now.AddDays(-29).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var url = $"{_baseUrl()}/functions/tokentracker-usage-model-breakdown"
                      + $"?from={from}&to={today}{tzQuery}&{AccountQuery}";
            using var resp = await Http.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return NoModels;
            await using var stream = await resp.Content.ReadAsStreamAsync();
            using var doc = await JsonDocument.ParseAsync(stream);
            if (!doc.RootElement.TryGetProperty("sources", out var sources)
                || sources.ValueKind != JsonValueKind.Array) return NoModels;

            var tokensByKey = new Dictionary<string, long>();
            var nameByKey = new Dictionary<string, string>();
            var sourceByKey = new Dictionary<string, string>();
            var weightByKey = new Dictionary<string, long>();
            long totalTokensAll = 0;

            foreach (var src in sources.EnumerateArray())
            {
                var srcName = src.TryGetProperty("source", out var sn) ? sn.GetString() ?? "" : "";
                if (!src.TryGetProperty("models", out var modelsEl) || modelsEl.ValueKind != JsonValueKind.Array)
                    continue;
                foreach (var m in modelsEl.EnumerateArray())
                {
                    long mt = m.TryGetProperty("totals", out var mtotals) ? GetLong(mtotals, "billable_total_tokens") : 0;
                    if (mt <= 0) continue;
                    var name = m.TryGetProperty("model", out var mn) ? mn.GetString() ?? "" : "";
                    if (string.IsNullOrEmpty(name)) name = "—";
                    var key = name.ToLowerInvariant().Trim();
                    if (key.Length == 0) continue;

                    totalTokensAll += mt;
                    tokensByKey[key] = tokensByKey.GetValueOrDefault(key) + mt;
                    if (mt >= weightByKey.GetValueOrDefault(key))
                    {
                        weightByKey[key] = mt;
                        nameByKey[key] = name;
                        sourceByKey[key] = srcName;
                    }
                }
            }

            if (tokensByKey.Count == 0) return NoModels;
            long totalTokens = totalTokensAll > 0 ? totalTokensAll : tokensByKey.Values.Sum();

            return tokensByKey
                .Select(kv => new
                {
                    Tokens = kv.Value,
                    Stat = new TopModelStat(
                        nameByKey.GetValueOrDefault(kv.Key, "—"),
                        totalTokens > 0
                            ? (kv.Value / (double)totalTokens * 100).ToString("0.0", CultureInfo.InvariantCulture)
                            : "0.0",
                        sourceByKey.GetValueOrDefault(kv.Key, "")),
                })
                .OrderByDescending(x => x.Tokens)
                .ThenBy(x => x.Stat.Name, StringComparer.Ordinal)
                .Take(5)
                .Select(x => x.Stat)
                .ToList();
        }
        catch { return NoModels; }
    }

    private static long GetLong(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out var el)) return 0;
        return el.ValueKind switch
        {
            JsonValueKind.Number => el.TryGetInt64(out var v) ? v : (long)el.GetDouble(),
            JsonValueKind.String => long.TryParse(el.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var s) ? s : 0,
            _ => 0,
        };
    }

    /// <summary>The usage endpoints expect an IANA tz; Windows uses its own ids, so convert.</summary>
    private static string TimeZoneQuery()
    {
        var offsetMin = (int)DateTimeOffset.Now.Offset.TotalMinutes;
        var tz = ResolveIanaTimeZone();
        return $"&tz={Uri.EscapeDataString(tz)}&tz_offset_minutes={offsetMin}";
    }

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
