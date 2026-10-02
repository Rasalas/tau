import AVFoundation
import Speech
import Foundation

/// Continuous on-device recognition. Finalized phrases enter the draft while the microphone stays open.
@available(iOS 26.0, *)
@MainActor
final class LocalDictation {
    private var generation = 0
    private var engine: AVAudioEngine?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var downloadTask: Task<Void, Error>?
    private var analysisTask: Task<Void, Error>?
    private var resultsTask: Task<String, Error>?
    private var analyzer: SpeechAnalyzer?
    private var timer: Timer?
    private var interruption: NSObjectProtocol?
    private var text = ""
    private var preview = ""
    private var lastLevelUpdate = Date.distantPast
    private var update: (([String: Any]) -> Void)?

    func languages() async -> [[String: Any]] {
        guard SpeechTranscriber.isAvailable else { return [] }
        let installed = await SpeechTranscriber.installedLocales
        return await SpeechTranscriber.supportedLocales.map { locale in
            ["id": locale.identifier, "name": Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier,
             "installed": installed.contains(locale)]
        }.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    }

    func defaultLanguage() async -> String? {
        // Follow the user's language order, not the order of the supported-language list.
        for language in Locale.preferredLanguages {
            if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) { return locale.identifier }
        }
        return nil
    }

    func download(_ language: String) async throws {
        let current = generation
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) else { throw problem("This language is not supported on this device.") }
        guard generation == current else { throw CancellationError() }
        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        let work = Task { if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await request.downloadAndInstall() } }
        downloadTask = work
        defer { if generation == current { downloadTask = nil } }
        try await work.value
    }

    func start(_ language: String, update: @escaping ([String: Any]) -> Void) async throws {
        cancel()
        let current = generation
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)),
              await SpeechTranscriber.installedLocales.contains(locale) else { throw problem("Download this language's speech model before recording.") }
        guard generation == current else { throw CancellationError() }
        guard await AVAudioApplication.requestRecordPermission() else { throw problem("Microphone access was denied. Allow Tau in Settings to dictate.") }
        guard generation == current else { throw CancellationError() }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement)
            try session.setActive(true)
            let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            let engine = AVAudioEngine()
            let sourceFormat = engine.inputNode.outputFormat(forBus: 0)
            guard sourceFormat.sampleRate > 0, sourceFormat.channelCount > 0,
                  let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: sourceFormat) else { throw problem("The microphone has no supported audio format.") }
            try await analyzer.prepareToAnalyze(in: format)
            guard generation == current else { throw CancellationError() }
            let converter = try DictationAudioConverter(from: sourceFormat, to: format)
            let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            self.engine = engine; self.analyzer = analyzer; self.input = continuation
            self.update = update; text = ""; preview = ""; lastLevelUpdate = .distantPast
            resultsTask = Task {
                do {
                    for try await result in transcriber.results {
                        guard generation == current else { throw CancellationError() }
                        let words = String(result.text.characters)
                        if result.isFinal { text += words; preview = "" } else { preview = words }
                        update(["text": text, "preview": preview])
                    }
                    return text
                } catch {
                    if generation == current { update(["text": text, "error": error.localizedDescription]); cancel() }
                    throw error
                }
            }
            analysisTask = Task {
                do { try await analyzer.start(inputSequence: stream) }
                catch {
                    if generation == current { update(["text": text, "error": error.localizedDescription]); cancel() }
                    throw error
                }
            }
            engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: sourceFormat) { [weak self] buffer, _ in
                do {
                    let converted = try converter.convert(buffer)
                    continuation.yield(AnalyzerInput(buffer: converted))
                    let level = DictationAudioConverter.level(buffer)
                    Task { @MainActor in
                        guard let self, self.generation == current, Date().timeIntervalSince(self.lastLevelUpdate) >= 0.1 else { return }
                        self.lastLevelUpdate = Date()
                        self.update?(["text": self.text, "preview": self.preview, "level": level])
                    }
                } catch {
                    let message = error.localizedDescription
                    Task { @MainActor in
                        guard let self, self.generation == current else { return }
                        self.update?(["text": self.text, "error": message]); self.cancel()
                    }
                }
            }
            engine.prepare()
            try engine.start()
            interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] notification in
                guard let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      type == AVAudioSession.InterruptionType.began.rawValue else { return }
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    self.update?(["text": self.text, "error": "Dictation stopped because the microphone was interrupted."])
                    self.cancel()
                }
            }
            // Stop the microphone even if the web view is suspended. The UI also enforces this limit.
            timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: false) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    self.stopMicrophone()
                    update(["text": self.text, "limitReached": true])
                }
            }
        } catch { if generation == current { cancel() }; throw error }
    }

    func finish() async throws -> String {
        guard let analyzer, let resultsTask, let analysisTask else { throw problem("No dictation recording is available.") }
        let current = generation
        stopMicrophone()
        input?.finish(); input = nil
        defer { if generation == current { cancel() } }
        try await analysisTask.value
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        return try await resultsTask.value
    }

    private func stopMicrophone() {
        timer?.invalidate(); timer = nil
        if let interruption { NotificationCenter.default.removeObserver(interruption) }
        interruption = nil
        if let engine { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        engine = nil
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    func cancel(notify: Bool = false) {
        if notify { update?(["text": text, "cancelled": true]) }
        generation += 1
        downloadTask?.cancel(); downloadTask = nil
        stopMicrophone(); input?.finish(); input = nil
        analysisTask?.cancel(); analysisTask = nil
        resultsTask?.cancel(); resultsTask = nil
        if let analyzer { Task { await analyzer.cancelAndFinishNow() } }
        analyzer = nil; update = nil; text = ""; preview = ""
    }

    private func problem(_ text: String) -> NSError { NSError(domain: "TauDictation", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}

/// Used only by one audio tap. Each yielded buffer owns its samples, never the tap's reusable storage.
private final class DictationAudioConverter: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let format: AVAudioFormat
    init(from source: AVAudioFormat, to target: AVAudioFormat) throws {
        guard let converter = AVAudioConverter(from: source, to: target) else { throw NSError(domain: "TauDictation", code: 2, userInfo: [NSLocalizedDescriptionKey: "The microphone audio format could not be converted."]) }
        self.converter = converter; format = target
    }
    func convert(_ source: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        let capacity = AVAudioFrameCount(ceil(Double(source.frameLength) * format.sampleRate / source.format.sampleRate)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { throw NSError(domain: "TauDictation", code: 3) }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if supplied { inputStatus.pointee = .noDataNow; return nil }
            supplied = true; inputStatus.pointee = .haveData; return source
        }
        if let error { throw error }
        if status == .error { throw NSError(domain: "TauDictation", code: 4) }
        return output
    }
    static func level(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
        return min(1, sqrt(sum / Float(buffer.frameLength)) * 8)
    }
}
