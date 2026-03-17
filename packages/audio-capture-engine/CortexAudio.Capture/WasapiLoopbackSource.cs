using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace CortexAudio.Capture;

/// <summary>
/// WASAPI loopback capture source. Captures system audio output (speakers).
/// </summary>
public class WasapiLoopbackSource : IAudioSource
{
    private readonly WasapiLoopbackCapture _capture;

    public WasapiLoopbackSource()
    {
        _capture = new WasapiLoopbackCapture();
        _capture.DataAvailable += (s, e) => DataAvailable?.Invoke(this, e);
    }

    public WaveFormat WaveFormat => _capture.WaveFormat;
    public event EventHandler<WaveInEventArgs>? DataAvailable;

    public void StartRecording() => _capture.StartRecording();
    public void StopRecording() => _capture.StopRecording();
    public void Dispose() => _capture.Dispose();
}
