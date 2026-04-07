import SwiftUI
import WidgetKit

@main
struct TokenTrackerWidgetBundle: WidgetBundle {
    var body: some Widget {
        SummaryWidget()
        TrendWidget()
        TopModelsWidget()
        UsageLimitsWidget()
        HeatmapWidget()
        ClawdWidget()
    }
}
