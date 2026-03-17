using NAudio.Wave;

namespace CortexAudio.Capture.Tests;

/// <summary>
/// Fake audio source for testing. Allows injecting PCM data on demand.
/// </summary>
public class FakeAudioSource : IAudioSource
{
    public WaveFormat WaveFormat { get; }
    public event EventHandler<WaveInEventArgs>? DataAvailable;

    private bool _recording;

    public FakeAudioSource(int sampleRate = 44100, int bitsPerSample = 16, int channels = 1)
    {
        WaveFormat = new WaveFormat(sampleRate, bitsPerSample, channels);
    }

    public void StartRecording() => _recording = true;
    public void StopRecording() => _recording = false;
    public void Dispose() { }

    /// <summary>
    /// Inject audio data, triggering DataAvailable event.
    /// </summary>
    public void Feed(byte[] data)
    {
        DataAvailable?.Invoke(this, new WaveInEventArgs(data, data.Length));
    }

    /// <summary>
    /// Generate a sine wave tone as 16-bit mono PCM.
    /// </summary>
    public static byte[] GenerateTone(int sampleRate, double frequency, double durationSeconds, double amplitude = 0.5)
    {
        int sampleCount = (int)(sampleRate * durationSeconds);
        byte[] buffer = new byte[sampleCount * 2];
        for (int i = 0; i < sampleCount; i++)
        {
            double sample = amplitude * Math.Sin(2 * Math.PI * frequency * i / sampleRate);
            short s = (short)(sample * 32767);
            buffer[i * 2] = (byte)(s & 0xFF);
            buffer[i * 2 + 1] = (byte)((s >> 8) & 0xFF);
        }
        return buffer;
    }

    /// <summary>
    /// Generate silent 16-bit mono PCM.
    /// </summary>
    public static byte[] GenerateSilence(int sampleRate, double durationSeconds)
    {
        int sampleCount = (int)(sampleRate * durationSeconds);
        return new byte[sampleCount * 2];
    }
}

/// <summary>
/// Controllable time provider for testing.
/// </summary>
public class FakeTimeProvider : ITimeProvider
{
    public DateTime UtcNow { get; set; } = DateTime.UtcNow;

    public void Advance(TimeSpan duration) => UtcNow += duration;
}
