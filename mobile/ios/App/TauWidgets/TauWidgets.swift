import SwiftUI
import WidgetKit

// Views and data contract: PlanLimitsWidget, ThreadsWidget, LiveActivity, Theme, and
// WidgetModel.swift (shared with the app's plugin). Mocks: K163, .scratch/design/widgets.
@main struct TauWidgets: WidgetBundle {
    var body: some Widget {
        PlanLimitsWidget()
        ThreadsWidget()
        TauLiveActivity()
    }
}
