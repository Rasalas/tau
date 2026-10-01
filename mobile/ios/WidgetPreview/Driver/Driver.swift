import XCTest

// Drives SpringBoard: adds the widgets, then captures each Live Activity state on the lock
// screen and in the Dynamic Island. Each `xcodebuild test` reinstalls the app, which ends its
// activities, so a state is created and captured within one test.
final class Driver: XCTestCase {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    var out: String { ProcessInfo.processInfo.environment["SHOTS"] ?? NSTemporaryDirectory() }
    let title = "Fix flaky checkpoint lease test"

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

    func openTauGallery() {
        button(["Bearbeiten", "Edit"]).tap(); sleep(1)
        springboard.buttons.matching(NSPredicate(format: "label CONTAINS 'Widget'")).firstMatch.tap(); sleep(2)
        let search = springboard.searchFields.firstMatch
        search.tap(); search.typeText("Tau"); sleep(2)
        springboard.cells["Tau"].firstMatch.tap(); sleep(5)
    }
    func addWidget() { springboard.buttons.matching(NSPredicate(format: "label CONTAINS 'Widget hinzuf' OR label CONTAINS 'Add Widget'")).firstMatch.tap(); sleep(3) }

    func testHomeWidgets() {
        launch(["-clear", "-usage"])
        XCUIDevice.shared.press(.home); sleep(2)
        point(0.5, 0.75).press(forDuration: 1.5); sleep(2)
        openTauGallery(); shot("gallery-small")
        point(0.8, 0.6).press(forDuration: 0.05, thenDragTo: point(0.1, 0.6)); sleep(3)
        shot("gallery-medium"); addWidget()
        openTauGallery(); addWidget()
        button(["Fertig", "Done"]).tap(); sleep(6)
        shot("home-light")
        launch(["-clear"]); XCUIDevice.shared.press(.home); sleep(6); shot("home-empty")
        launch(["-usage"])
    }

    func blank() { point(0.75, 0.72).tap() }
    func lockAndWake() {
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton")); sleep(2)
        XCUIDevice.shared.press(.home); sleep(3)
        let allow = button(["Erlauben", "Immer erlauben", "Allow", "Always Allow"])
        if allow.exists { allow.tap(); sleep(3) }
    }
    func island(_ name: String) {
        blank(); sleep(5); shot(name + "-island-compact")
        point(0.5, 0.027).press(forDuration: 1.2); sleep(3)
        shot(name + "-island-expanded"); blank(); sleep(2)
    }
    func capture(_ name: String, island withIsland: Bool = true) {
        XCUIDevice.shared.appearance = .light; sleep(3)
        XCUIDevice.shared.press(.home); sleep(2)
        if withIsland { island(name + "-light") }
        lockAndWake(); shot(name + "-lock-light")
        XCUIDevice.shared.appearance = .dark; sleep(3); shot(name + "-lock-dark")
        point(0.5, 0.995).press(forDuration: 0.1, thenDragTo: point(0.5, 0.2)); sleep(2)
        if withIsland { island(name + "-dark") }
        XCUIDevice.shared.appearance = .light
    }

    func testLiveActivities() {
        launch(["-end"]); sleep(2) // the first launch after install can miss its arguments
        launch(["-usage", "-activity", "t1", "running", title]); capture("la-running")
        launch(["-activity", "t1", "needs-input", title]); capture("la-asking")
        launch(["-activity", "t2", "running", "Upgrade Electron to 39 and fix the preload bridge", "-activity", "t3", "needs-input", "Review kit migration plan"]); capture("la-multi", island: false)
        launch(["-activity", "t1", "completed", title, "900"]); capture("la-completed", island: false)
        launch(["-end", "-activity", "t4", "running", "Nightly dependency audit", "15"]); sleep(90); capture("la-stale")
    }
}
