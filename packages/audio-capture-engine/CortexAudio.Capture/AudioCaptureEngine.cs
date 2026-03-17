using NAudio.Wave;

namespace CortexAudio.Capture;

/// <summary>
/// Main audio capture engine. Orchestrates mic and speaker capture,
/// stereo mixing, chunk writing, and silence detection.
/// </summary>
public class AudioCaptureEngine : IDisposable
{
    private readonly AudioCaptureConfig _config;
    private readonly IAudioSource _micSource;
    private readonly IAudioSource _speakerSource;
    private readonly SilenceDetector _silenceDetector;
    private WavChunkWriter? _chunkWriter;
    private readonly object _lock = new();

    // Buffers to hold latest data from each source
    private byte[] _micBuffer = Array.Empty<byte>();
    private int _micBufferLen;
    private byte[] _speakerBuffer = Array.Empty<byte>();
    private int _speakerBufferLen;

    private bool _capturing;
    private string? _sessionId;

    public event Action<string>? ChunkReady;
    public event Action? SessionEnd;

    public AudioCaptureEngine(AudioCaptureConfig config, IAudioSource micSource, IAudioSource speakerSource)
    {
        config.Validate();
        _config = config;
        _micSource = micSource;
        _speakerSource = speakerSource;
        _silenceDetector = new SilenceDetector(config.SilenceThresholdDb, config.SilenceTimeoutSeconds);
    }

    /// <summary>
    /// Constructor with custom time provider for testing silence detection timing.
    /// </summary>
    public AudioCaptureEngine(AudioCaptureConfig config, IAudioSource micSource, IAudioSource speakerSource, ITimeProvider timeProvider)
    {
        config.Validate();
        _config = config;
        _micSource = micSource;
        _speakerSource = speakerSource;
        _silenceDetector = new SilenceDetector(config.SilenceThresholdDb, config.SilenceTimeoutSeconds, timeProvider);
    }

    public bool IsCapturing => _capturing;
    public string? CurrentSessionId => _sessionId;

    public void Start(string sessionId)
    {
        if (_capturing)
            throw new InvalidOperationException("Already capturing.");

        _sessionId = sessionId;

        var stereoFormat = new WaveFormat(_config.SampleRate, 16, 2);
        _chunkWriter = new WavChunkWriter(sessionId, _config.OutboxDir, _config.MaxChunkSizeBytes, stereoFormat);
        _chunkWriter.ChunkReady += path => ChunkReady?.Invoke(path);

        _silenceDetector.Reset();
        _silenceDetector.SilenceDetected += OnSilenceDetected;

        _micSource.DataAvailable += OnMicData;
        _speakerSource.DataAvailable += OnSpeakerData;

        _capturing = true;

        _micSource.StartRecording();
        _speakerSource.StartRecording();
    }

    public void Stop()
    {
        if (!_capturing) return;

        _capturing = false;

        try { _micSource.StopRecording(); } catch { }
        try { _speakerSource.StopRecording(); } catch { }

        _micSource.DataAvailable -= OnMicData;
        _speakerSource.DataAvailable -= OnSpeakerData;
        _silenceDetector.SilenceDetected -= OnSilenceDetected;

        lock (_lock)
        {
            _chunkWriter?.Flush();
            _chunkWriter?.Dispose();
            _chunkWriter = null;
        }

        SessionEnd?.Invoke();
    }

    public void Dispose()
    {
        if (_capturing) Stop();
        _micSource.Dispose();
        _speakerSource.Dispose();
    }

    private void OnMicData(object? sender, WaveInEventArgs e)
    {
        lock (_lock)
        {
            EnsureBuffer(ref _micBuffer, e.BytesRecorded);
            Buffer.BlockCopy(e.Buffer, 0, _micBuffer, 0, e.BytesRecorded);
            _micBufferLen = e.BytesRecorded;
            MixAndWrite();
        }
    }

    private void OnSpeakerData(object? sender, WaveInEventArgs e)
    {
        lock (_lock)
        {
            EnsureBuffer(ref _speakerBuffer, e.BytesRecorded);
            Buffer.BlockCopy(e.Buffer, 0, _speakerBuffer, 0, e.BytesRecorded);
            _speakerBufferLen = e.BytesRecorded;
            MixAndWrite();
        }
    }

    private void MixAndWrite()
    {
        if (_micBufferLen == 0 && _speakerBufferLen == 0) return;
        if (_chunkWriter == null) return;

        var micSpan = new ReadOnlySpan<byte>(_micBuffer, 0, _micBufferLen);
        var speakerSpan = new ReadOnlySpan<byte>(_speakerBuffer, 0, _speakerBufferLen);

        byte[] stereo = StereoMixer.Mix(micSpan, speakerSpan);
        _chunkWriter.Write(stereo, stereo.Length);

        _silenceDetector.Process(stereo);

        // Clear buffers after mixing
        _micBufferLen = 0;
        _speakerBufferLen = 0;
    }

    private void OnSilenceDetected()
    {
        Stop();
    }

    private static void EnsureBuffer(ref byte[] buffer, int needed)
    {
        if (buffer.Length < needed)
            buffer = new byte[needed];
    }
}
