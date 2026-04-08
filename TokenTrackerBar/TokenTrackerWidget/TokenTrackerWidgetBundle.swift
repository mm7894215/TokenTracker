import SwiftUI
import WidgetKit

@main
struct TokenTrackerWidgetBundle: WidgetBundle {
    var body: some Widget {
        SummaryWidget()
        HeatmapWidget()
        TopModelsWidget()
        UsageLimitsWidget()
    }
}
