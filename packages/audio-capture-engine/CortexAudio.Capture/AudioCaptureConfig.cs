namespace CortexAudio.Capture;

public class AudioCaptureConfig
{
    public int MaxChunkSizeMB { get; set; } = 10;
    public int SilenceTimeoutSeconds { get; set; } = 60;
    public double SilenceThresholdDb { get; set; } = -50;
    public int SampleRate { get; set; } = 44100;
    public string OutboxDir { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "CortexAudio", "outbox");

    public long MaxChunkSizeBytes => MaxChunkSizeMB * 1024L * 1024L;

    public void Validate()
    {
        if (MaxChunkSizeMB <= 0)
            throw new ArgumentException("MaxChunkSizeMB must be positive.", nameof(MaxChunkSizeMB));
        if (SilenceTimeoutSeconds <= 0)
            throw new ArgumentException("SilenceTimeoutSeconds must be positive.", nameof(SilenceTimeoutSeconds));
        if (SilenceThresholdDb >= 0)
            throw new ArgumentException("SilenceThresholdDb must be negative.", nameof(SilenceThresholdDb));
        if (SampleRate <= 0)
            throw new ArgumentException("SampleRate must be positive.", nameof(SampleRate));
        if (string.IsNullOrWhiteSpace(OutboxDir))
            throw new ArgumentException("OutboxDir must not be empty.", nameof(OutboxDir));
    }
}
