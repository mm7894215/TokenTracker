import SwiftUI

/// Shown when the server failed to start or became unreachable.
struct ServerOfflineView: View {
    let message: String
    let onRetry: () async -> Void

    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "bolt.trianglebadge.exclamationmark")
                .font(.system(size: 32))
                .foregroundStyle(.secondary)
            Text(Strings.serverUnavailable)
                .font(.headline)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Text(Strings.serverOfflineHint)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Button(Strings.retryButton) {
                Task { await onRetry() }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

/// Shown while the server is starting up.
struct ServerStartingView: View {
    var body: some View {
        VStack(spacing: 12) {
            Spacer()
            ProgressView()
                .controlSize(.regular)
            Text(Strings.serverStarting)
                .font(.subheadline)
                .modifier(FontWeightModifier(weight: .medium))
            Text(Strings.serverPreparing)
                .font(.caption)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}
