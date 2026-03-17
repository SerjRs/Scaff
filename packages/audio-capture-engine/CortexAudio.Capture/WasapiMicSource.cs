using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace CortexAudio.Capture;

/// <summary>
/// WASAPI microphone capture source. Captures from the default input device.
/// </summary>
public class WasapiMicSource : IAudioSource
{
    private readonly WasapiCapture _capture;

    public WasapiMicSource(int sampleRate)
    {
        _capture = new WasapiCapture
        {
            WaveFormat = new WaveFormat(sampleRate, 16, 1)
        };
        _capture.DataAvailable += (s, e) => DataAvailable?.Invoke(this, e);
    }

    public WaveFormat WaveFormat => _capture.WaveFormat;
    public event EventHandler<WaveInEventArgs>? DataAvailable;

    public void StartRecording() => _capture.StartRecording();
    public void StopRecording() => _capture.StopRecording();
    public void Dispose() => _capture.Dispose();
}
