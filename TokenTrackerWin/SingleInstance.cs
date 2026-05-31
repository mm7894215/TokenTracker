using System.IO;
using System.IO.Pipes;

namespace TokenTrackerWin;

/// <summary>
/// Single-instance deep-link forwarding. The first launch owns a named pipe and listens
/// for messages; a second launch (e.g. Windows starting the app to handle a
/// <c>tokentracker://</c> deep link) connects, forwards its argument, and exits. This
/// lets the OAuth callback reach the already-running tray instance — the Windows
/// analogue of macOS <c>application(_:open:)</c>.
/// </summary>
internal static class SingleInstance
{
    private const string PipeName = "TokenTracker.Windows.Tray.DeepLink";

    /// <summary>
    /// Try to hand <paramref name="payload"/> to an already-running instance. Returns
    /// true if delivered (caller should then exit). Short timeout so a cold start where
    /// nobody is listening fails fast.
    /// </summary>
    public static bool TryForwardToPrimary(string payload)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(1500);
            using var writer = new StreamWriter(client) { AutoFlush = true };
            writer.WriteLine(payload);
            return true;
        }
        catch { return false; }
    }

    /// <summary>
    /// Start listening (primary instance only). <paramref name="onPayload"/> is invoked
    /// on a thread-pool thread for each forwarded message; the handler must marshal to
    /// the UI thread itself.
    /// </summary>
    public static void StartListener(Action<string> onPayload, CancellationToken token)
    {
        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(
                        PipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                    await server.WaitForConnectionAsync(token);
                    using var reader = new StreamReader(server);
                    var line = await reader.ReadLineAsync();
                    if (!string.IsNullOrWhiteSpace(line)) onPayload(line);
                }
                catch (OperationCanceledException) { break; }
                catch { /* drop this connection, keep listening */ }
            }
        }, token);
    }
}
