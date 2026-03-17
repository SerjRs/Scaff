using NAudio.Wave;

namespace CortexAudio.Capture;

/// <summary>
/// Abstraction over an audio input source (mic or loopback).
/// Implementations raise DataAvailable with PCM 16-bit mono samples.
/// </summary>
public interface IAudioSource : IDisposable
{
    WaveFormat WaveFormat { get; }
    event EventHandler<WaveInEventArgs> DataAvailable;
    void StartRecording();
    void StopRecording();
}
