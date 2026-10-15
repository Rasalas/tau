import UIKit
import Capacitor
import TauNativePlugin
import WebKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = TauBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// The web view with the system's edge swipe: it goes back in the page's history, from a chat to the thread list.
class TauBridgeViewController: CAPBridgeViewController {
    override func webViewConfiguration(for configuration: InstanceConfiguration) -> WKWebViewConfiguration {
        let result = super.webViewConfiguration(for: configuration)
        result.setURLSchemeHandler(BrowserResources.shared, forURLScheme: "tau-resource")
        return result
    }

    override func capacitorDidLoad() {
        webView?.allowsBackForwardNavigationGestures = true
        guard let bridge = bridge as? CapacitorBridge else { return }
        let controller = bridge.webViewDelegationHandler.contentController
        // WebKit exposes message handlers inside sandbox frames too. Capacitor's
        // handler must only receive calls from the installed workbench document.
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(MainFrameBridgeHandler(bridge.webViewDelegationHandler), name: "bridge")
    }
}

private final class MainFrameBridgeHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WebViewDelegationHandler?
    init(_ target: WebViewDelegationHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "capacitor", origin.host == "localhost", origin.port == 0 else { return }
        target?.userContentController(controller, didReceive: message)
    }
}
