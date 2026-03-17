namespace CortexAudio.Capture;

/// <summary>
/// Monitors stereo 16-bit PCM audio for sustained silence.
/// Fires SilenceDetected when audio stays below the dB threshold
/// for longer than the configured timeout.
/// </summary>
public class SilenceDetector
{
    private readonly double _thresholdDb;
    private readonly TimeSpan _timeout;
    private readonly ITimeProvider _time;
    private DateTime _lastLoudTime;
    private bool _fired;

    public event Action? SilenceDetected;

    public SilenceDetector(double thresholdDb, int timeoutSeconds, ITimeProvider? time = null)
    {
        _thresholdDb = thresholdDb;
        _timeout = TimeSpan.FromSeconds(timeoutSeconds);
        _time = time ?? new SystemTimeProvider();
        _lastLoudTime = _time.UtcNow;
    }

    public void Reset()
    {
        _lastLoudTime = _time.UtcNow;
        _fired = false;
    }

    /// <summary>
    /// Feed a buffer of 16-bit PCM samples (mono or stereo — we just check peak amplitude).
    /// </summary>
    public void Process(ReadOnlySpan<byte> pcm16)
    {
        if (_fired) return;

        double peakDb = CalculatePeakDb(pcm16);

        if (peakDb > _thresholdDb)
        {
            _lastLoudTime = _time.UtcNow;
            return;
        }

        if (_time.UtcNow - _lastLoudTime >= _timeout)
        {
            _fired = true;
            SilenceDetected?.Invoke();
        }
    }

    internal static double CalculatePeakDb(ReadOnlySpan<byte> pcm16)
    {
        if (pcm16.Length < 2) return double.NegativeInfinity;

        int peak = 0;
        for (int i = 0; i + 1 < pcm16.Length; i += 2)
        {
            int sample = Math.Abs((short)(pcm16[i] | (pcm16[i + 1] << 8)));
            if (sample > peak) peak = sample;
        }

        if (peak == 0) return double.NegativeInfinity;
        return 20.0 * Math.Log10(peak / 32768.0);
    }
}

public interface ITimeProvider
{
    DateTime UtcNow { get; }
}

public class SystemTimeProvider : ITimeProvider
{
    public DateTime UtcNow => DateTime.UtcNow;
}
