import AVFoundation
import Speech
import Foundation

/// Audio stays in a temporary file on the phone and is deleted at every terminal boundary.
@available(iOS 26.0, *)
@MainActor
final class LocalDictation {
    private var generation = 0
    private var recorder: AVAudioRecorder?
    private var recording: URL?
    private var locale: Locale?
    private var downloadTask: Task<Void, Error>?
    private var task: Task<String, Error>?
    private var analyzer: SpeechAnalyzer?
    private var timer: Timer?

    func languages() async -> [[String: Any]] {
        guard SpeechTranscriber.isAvailable else { return [] }
        let installed = await SpeechTranscriber.installedLocales
        return await SpeechTranscriber.supportedLocales.map { locale in
            ["id": locale.identifier, "name": Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier,
             "installed": installed.contains(locale)]
        }.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    }

    func download(_ language: String) async throws {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) else { throw problem("This language is not supported on this iPhone.") }
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        let work = Task { if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await request.downloadAndInstall() } }
        downloadTask = work
        defer { downloadTask = nil }
        try await work.value
    }

    func start(_ language: String) async throws {
        cancel()
        let current = generation
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)),
              await SpeechTranscriber.installedLocales.contains(locale) else { throw problem("Download this language's speech model before recording.") }
        guard await AVAudioApplication.requestRecordPermission() else { throw problem("Microphone access was denied. Allow Tau in Settings to dictate.") }
        guard generation == current else { throw CancellationError() }
        self.locale = locale
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tau-dictation-\(UUID().uuidString).caf")
        recording = url
        do {
            let next = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16])
            guard next.record(forDuration: 300) else { throw problem("The microphone could not start recording.") }
            recorder = next
            timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: false) { [weak self] _ in Task { @MainActor in self?.recorder?.stop() } }
        } catch { cancel(); throw error }
    }

    func finish() async throws -> String {
        guard let url = recording, let locale else { throw problem("No dictation recording is available.") }
        recorder?.stop(); recorder = nil; timer?.invalidate(); timer = nil
        try? AVAudioSession.sharedInstance().setActive(false)
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        let current = generation
        let work = Task<String, Error> {
            async let results: String = collect(transcriber)
            let file = try AVAudioFile(forReading: url)
            try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
            return try await results
        }
        task = work
        defer { if generation == current { cancel() } }
        return try await work.value
    }

    private func collect(_ transcriber: SpeechTranscriber) async throws -> String {
        var text = ""
        for try await result in transcriber.results { text += String(result.text.characters) }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func cancel() {
        generation += 1
        downloadTask?.cancel(); downloadTask = nil
        task?.cancel(); task = nil
        if let analyzer { Task { await analyzer.cancelAndFinishNow() } }
        analyzer = nil
        timer?.invalidate(); timer = nil
        recorder?.stop(); recorder = nil
        if let recording { try? FileManager.default.removeItem(at: recording) }
        recording = nil; locale = nil
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    private func problem(_ text: String) -> NSError { NSError(domain: "TauDictation", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}
