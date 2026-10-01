import XCTest

// Drives SpringBoard: adds the widgets through the widget gallery, captures each data state
// in light and dark, then each Live Activity state on the lock screen and in the Dynamic
// Island. Each `xcodebuild test` reinstalls the app, which ends its activities, so a state is
// created and captured within one test. Simulator language English.
final class Driver: XCTestCase {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    var out: String { ProcessInfo.processInfo.environment["SHOTS"] ?? NSTemporaryDirectory() }

    func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
    }
    func button(_ labels: [String]) -> XCUIElement {
        springboard.buttons.matching(NSPredicate(format: "label IN %@", labels)).firstMatch
    }
    func point(_ x: Double, _ y: Double) -> XCUICoordinate { springboard.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
    func launch(_ args: [String]) {
        let app = XCUIApplication()
        app.launchArguments = args
        app.launch()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'ready'")).firstMatch.waitForExistence(timeout: 20))
    }
    func home(_ wait: UInt32 = 4) { XCUIDevice.shared.press(.home); sleep(wait) }

    func openTauGallery() {
        let edit = button(["Edit"])
        if !edit.waitForExistence(timeout: 3) { point(0.5, 0.6).press(forDuration: 1.5); sleep(2) }
        button(["Edit"]).tap(); sleep(1)
        springboard.buttons.matching(NSPredicate(format: "label CONTAINS 'Widget'")).firstMatch.tap(); sleep(2)
        let search = springboard.searchFields.firstMatch
        search.tap(); search.typeText("Tau"); sleep(2)
        // A fresh simulator lists a new extension only after a while.
        for _ in 0..<6 where !springboard.cells["Tau"].firstMatch.exists {
            sleep(10); search.buttons.firstMatch.tap(); search.typeText("Tau"); sleep(3)
        }
        springboard.cells["Tau"].firstMatch.tap(); sleep(4)
    }
    /// The app's gallery pages: Plan limits small, medium, large, then Threads small, medium.
    func addWidget(page: Int) {
        openTauGallery()
        // Below the preview: a drag on the preview itself picks the widget up instead of paging.
        for _ in 0..<page { point(0.9, 0.8).press(forDuration: 0.05, thenDragTo: point(0.1, 0.8)); sleep(2) }
        shot("gallery-\(page)")
        springboard.buttons.matching(NSPredicate(format: "label CONTAINS 'Add Widget'")).firstMatch.tap(); sleep(3)
    }
    /// Leaves the home screen's edit mode; the home button keeps what was added.
    func done() {
        XCUIDevice.shared.press(.home); sleep(3)
        shot("home-done")
    }

    /// Every data state of what is on the home screen, light then dark.
    func states(_ names: [String], prefix: String) {
        for appearance in [XCUIDevice.Appearance.light, .dark] {
            XCUIDevice.shared.appearance = appearance; sleep(2)
            for name in names {
                launch(["-scenario", name]); home(6)
                shot("\(prefix)-\(name)-\(appearance == .light ? "light" : "dark")")
            }
        }
        XCUIDevice.shared.appearance = .light
    }

    func testHomeWidgets() {
        XCUIDevice.shared.appearance = .light
        launch(["-scenario", "normal"]); home()
        point(0.5, 0.6).press(forDuration: 1.5); sleep(2)
        addWidget(page: 4)   // Threads medium
        addWidget(page: 1)   // Plan limits medium
        addWidget(page: 3)   // Threads small
        addWidget(page: 0)   // Plan limits small
        shot("home-added")
        done()
        states(["normal", "spent", "stale", "empty", "quiet"], prefix: "home")
    }

    /// The large size, on a home screen of its own: run after testHomeWidgets on a fresh simulator, or alone.
    func testLargeWidget() {
        XCUIDevice.shared.appearance = .light
        launch(["-scenario", "normal"]); home()
        point(0.5, 0.6).press(forDuration: 1.5); sleep(2)
        addWidget(page: 2)
        done()
        states(["normal", "spent", "stale"], prefix: "large")
        // Off again, so testHomeWidgets has the page to itself.
        launch(["-scenario", "normal"]); home()
        point(0.5, 0.25).press(forDuration: 1.5); sleep(2)
        springboard.buttons.matching(NSPredicate(format: "label CONTAINS 'Remove Widget'")).firstMatch.tap(); sleep(2)
        springboard.buttons.matching(NSPredicate(format: "label == 'Remove'")).firstMatch.tap(); sleep(3)
        shot("large-removed")
    }

    /// The lock screen's own widgets (choice B): Threads inline above the clock, Plan limits and Threads below it.
    func testLockWidgets() {
        XCUIDevice.shared.appearance = .light
        launch(["-scenario", "normal"]); home()
        lockAndWake(); sleep(2)
        point(0.5, 0.55).press(forDuration: 1.8); sleep(3)
        button(["Customize", "Customise"]).tap(); sleep(3)
        let lockScreen = springboard.buttons.matching(NSPredicate(format: "label CONTAINS 'Lock Screen'")).firstMatch
        if lockScreen.exists { lockScreen.tap() } else { point(0.27, 0.45).tap() }
        sleep(3)
        // The widget sheet: Tau's first page is Plan limits (circular, rectangular), its second Threads.
        let add = springboard.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Add Widget'")).firstMatch
        if add.exists { add.tap() } else { point(0.5, 0.34).tap() }
        sleep(3)
        springboard.cells.matching(NSPredicate(format: "label CONTAINS 'Tau'")).firstMatch.tap(); sleep(3)
        point(0.61, 0.71).tap(); sleep(2)
        point(0.85, 0.62).press(forDuration: 0.05, thenDragTo: point(0.15, 0.62)); sleep(2)
        shot("lock-step-threads")
        point(0.61, 0.71).tap(); sleep(2)
        shot("lock-step-added")
        point(0.9, 0.48).tap(); sleep(2)
        // The inline line above the clock.
        point(0.5, 0.093).tap(); sleep(3); shot("lock-step-inline")
        springboard.cells.matching(NSPredicate(format: "label CONTAINS 'Tau'")).firstMatch.tap(); sleep(3)
        shot("lock-step-inline-tau")
        point(0.5, 0.71).tap(); sleep(2)
        point(0.9, 0.48).tap(); sleep(2)
        shot("lock-step-edited")
        button(["Done"]).tap(); sleep(3)
        shot("lock-step-done")
        blank(); sleep(2)
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton")); sleep(2)
        XCUIDevice.shared.press(.home); sleep(4)
        shot("lock-widgets-light")
        XCUIDevice.shared.appearance = .dark; sleep(4); shot("lock-widgets-dark")
        XCUIDevice.shared.appearance = .light
    }

    /// Where the widgets went: each home page and the Today view.
    func testLookAround() {
        home(); shot("look-0")
        for page in 1...3 { point(0.9, 0.5).press(forDuration: 0.05, thenDragTo: point(0.1, 0.5)); sleep(2); shot("look-\(page)") }
        home(); point(0.1, 0.5).press(forDuration: 0.05, thenDragTo: point(0.9, 0.5)); sleep(2); shot("look-today")
    }

    func blank() { point(0.75, 0.72).tap() }
    func lockAndWake() {
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton")); sleep(2)
        XCUIDevice.shared.press(.home); sleep(3)
        let allow = button(["Allow", "Always Allow"])
        if allow.exists { allow.tap(); sleep(3) }
    }
    func island(_ name: String) {
        blank(); sleep(4); shot(name + "-island-compact")
        point(0.5, 0.027).press(forDuration: 1.6); sleep(4)
        shot(name + "-island-expanded"); blank(); sleep(2)
    }
    func capture(_ name: String, island withIsland: Bool = true) {
        XCUIDevice.shared.appearance = .light; sleep(3)
        home(2)
        if withIsland { island(name + "-light") }
        lockAndWake(); shot(name + "-lock-light")
        XCUIDevice.shared.appearance = .dark; sleep(3); shot(name + "-lock-dark")
        point(0.5, 0.995).press(forDuration: 0.1, thenDragTo: point(0.5, 0.2)); sleep(2)
        if withIsland { island(name + "-dark") }
        XCUIDevice.shared.appearance = .light
    }

    func testLiveActivities() {
        launch(["-end"]); sleep(2) // the first launch after install can miss its arguments
        launch(["-scenario", "normal", "-end", "-activity", "running"]); capture("la-running")
        launch(["-end", "-activity", "waiting"]); capture("la-waiting")
        launch(["-end", "-activity", "bundle"]); capture("la-bundle")
        launch(["-end", "-activity", "done"]); capture("la-done", island: false)
        launch(["-end", "-activity", "failed"]); capture("la-failed", island: false)
        launch(["-end", "-activity", "stale"]); sleep(5); capture("la-stale")
    }
}
