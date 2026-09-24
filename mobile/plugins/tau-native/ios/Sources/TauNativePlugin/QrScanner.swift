import AVFoundation
import UIKit

/// A full-screen camera that reads one QR code, with a close button at the
/// top right. The system recognises the code; nothing leaves the device.
final class QrScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    enum Outcome { case text(String), cancelled, failed(String) }

    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var done: ((Outcome) -> Void)?

    init(done: @escaping (Outcome) -> Void) {
        self.done = done
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
            finish(.failed("no-camera"))
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            finish(.failed("no-camera"))
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview

        let hint = UILabel()
        hint.text = "Scan the code in Settings → Connections"
        hint.textColor = .white
        hint.font = .preferredFont(forTextStyle: .body)
        hint.textAlignment = .center
        hint.numberOfLines = 0
        hint.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)

        let close = UIButton(type: .system)
        close.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)), for: .normal)
        close.tintColor = .white
        close.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        close.layer.cornerRadius = 22
        close.accessibilityLabel = "Close scanner"
        close.translatesAutoresizingMaskIntoConstraints = false
        close.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        view.addSubview(close)

        NSLayoutConstraint.activate([
            close.widthAnchor.constraint(equalToConstant: 44),
            close.heightAnchor.constraint(equalToConstant: 44),
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            close.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            hint.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            hint.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -32)
        ])
        DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first?.stringValue else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        finish(.text(code))
    }

    @objc private func cancel() { finish(.cancelled) }

    private func finish(_ outcome: Outcome) {
        guard let done else { return }
        self.done = nil
        DispatchQueue.global(qos: .userInitiated).async { [session] in session.stopRunning() }
        DispatchQueue.main.async {
            if self.presentingViewController != nil { self.dismiss(animated: true) { done(outcome) } } else { done(outcome) }
        }
    }
}
