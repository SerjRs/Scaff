namespace CortexAudio.Capture;

/// <summary>
/// Mixes two mono 16-bit PCM buffers into an interleaved stereo buffer.
/// Left channel = mic (user), Right channel = speakers (others).
/// </summary>
public static class StereoMixer
{
    /// <summary>
    /// Interleave two mono 16-bit PCM byte arrays into stereo.
    /// If one buffer is shorter, the missing samples are filled with silence.
    /// </summary>
    public static byte[] Mix(ReadOnlySpan<byte> micMono, ReadOnlySpan<byte> speakerMono)
    {
        // Each sample is 2 bytes (16-bit). Calculate sample counts.
        int micSamples = micMono.Length / 2;
        int speakerSamples = speakerMono.Length / 2;
        int maxSamples = Math.Max(micSamples, speakerSamples);

        // Stereo: 2 channels * 2 bytes per sample = 4 bytes per frame
        byte[] stereo = new byte[maxSamples * 4];

        for (int i = 0; i < maxSamples; i++)
        {
            int stereoOffset = i * 4;

            // Left channel = mic
            if (i < micSamples)
            {
                stereo[stereoOffset] = micMono[i * 2];
                stereo[stereoOffset + 1] = micMono[i * 2 + 1];
            }
            // else zeros (silence) — already default

            // Right channel = speaker
            if (i < speakerSamples)
            {
                stereo[stereoOffset + 2] = speakerMono[i * 2];
                stereo[stereoOffset + 3] = speakerMono[i * 2 + 1];
            }
        }

        return stereo;
    }
}
