import WidgetKit
import SwiftUI
import AppIntents

// Single timeline entry that wraps the latest `WidgetSnapshot`. All widget
// kinds in this bundle reuse this provider — different widgets just render
// different slices of the same snapshot.

struct TokenTrackerEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
    let configuration: TokenTrackerWidgetIntent
}

struct TokenTrackerProvider: AppIntentTimelineProvider {

    typealias Entry = TokenTrackerEntry
    typealias Intent = TokenTrackerWidgetIntent

    func placeholder(in context: Context) -> TokenTrackerEntry {
        TokenTrackerEntry(date: Date(), snapshot: .placeholder, configuration: TokenTrackerWidgetIntent())
    }

    func snapshot(for configuration: TokenTrackerWidgetIntent, in context: Context) async -> TokenTrackerEntry {
        let s = WidgetSnapshotStore.read() ?? .placeholder
        return TokenTrackerEntry(date: Date(), snapshot: s, configuration: configuration)
    }

    func timeline(for configuration: TokenTrackerWidgetIntent, in context: Context) async -> Timeline<TokenTrackerEntry> {
        let snapshot = WidgetSnapshotStore.read() ?? .empty
        let entry = TokenTrackerEntry(date: Date(), snapshot: snapshot, configuration: configuration)

        // Refresh policy: ask the system to reload us in 15 minutes. The main
        // app also calls `WidgetCenter.reloadAllTimelines()` after every data
        // refresh — that path will preempt this scheduled reload whenever the
        // app is running.
        let refresh = Date().addingTimeInterval(15 * 60)
        return Timeline(entries: [entry], policy: .after(refresh))
    }
}
