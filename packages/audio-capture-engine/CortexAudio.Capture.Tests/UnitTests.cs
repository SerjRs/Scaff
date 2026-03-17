using System;
using System.IO;
using System.Threading;
using Xunit;

namespace CortexAudio.Capture.Tests;

/// <summary>
/// Unit tests for individual components.
/// </summary>
public class StereoMixerTests
{
    [Fact]
    public void Mix_MicOnLeftSpeakerOnRight()
    {
        // Arrange: distinct 16-bit mono samples
        // Mic: one sample value 1000 (0xE8, 0x03)
        // Speaker: one sample value 2000 (0xD0, 0x07)
        byte[] mic = [(byte)(1000 & 0xFF), (byte)(1000 >> 8)];
        byte[] speaker = [(byte)(2000 & 0xFF), (byte)(2000 >> 8)];

        // Act
        byte[] stereo = StereoMixer.Mix(mic, speaker);

        // Assert: 4 bytes total (L-low, L-high, R-low, R-high)
        Assert.Equal(4, stereo.Length);

        // Left channel (bytes 0-1) = mic
        short left = (short)(stereo[0] | (stereo[1] << 8));
        Assert.Equal(1000, left);

        // Right channel (bytes 2-3) = speaker
        short right = (short)(stereo[2] | (stereo[3] << 8));
        Assert.Equal(2000, right);
    }

    [Fact]
    public void Mix_EmptyMic_RightChannelHasSpeaker()
    {
        byte[] mic = [];
        byte[] speaker = [(byte)(500 & 0xFF), (byte)(500 >> 8)];

        byte[] stereo = StereoMixer.Mix(mic, speaker);

        Assert.Equal(4, stereo.Length);
        short left = (short)(stereo[0] | (stereo[1] << 8));
        short right = (short)(stereo[2] | (stereo[3] << 8));
        Assert.Equal(0, left);    // silence for mic
        Assert.Equal(500, right); // speaker value
    }

    [Fact]
    public void Mix_EmptySpeaker_LeftChannelHasMic()
    {
        byte[] mic = [(byte)(300 & 0xFF), (byte)(300 >> 8)];
        byte[] speaker = [];

        byte[] stereo = StereoMixer.Mix(mic, speaker);

        Assert.Equal(4, stereo.Length);
        short left = (short)(stereo[0] | (stereo[1] << 8));
        short right = (short)(stereo[2] | (stereo[3] << 8));
        Assert.Equal(300, left);  // mic value
        Assert.Equal(0, right);   // silence for speaker
    }

    [Fact]
    public void Mix_MultipleSamples_InterleavedCorrectly()
    {
        // 3 mono mic samples: 100, 200, 300
        byte[] mic = new byte[6];
        byte[] speaker = new byte[6];
        short[] micValues = [100, 200, 300];
        short[] speakerValues = [400, 500, 600];

        for (int i = 0; i < 3; i++)
        {
            mic[i * 2] = (byte)(micValues[i] & 0xFF);
            mic[i * 2 + 1] = (byte)(micValues[i] >> 8);
            speaker[i * 2] = (byte)(speakerValues[i] & 0xFF);
            speaker[i * 2 + 1] = (byte)(speakerValues[i] >> 8);
        }

        byte[] stereo = StereoMixer.Mix(mic, speaker);

        Assert.Equal(12, stereo.Length); // 3 frames * 4 bytes
        for (int i = 0; i < 3; i++)
        {
            short left = (short)(stereo[i * 4] | (stereo[i * 4 + 1] << 8));
            short right = (short)(stereo[i * 4 + 2] | (stereo[i * 4 + 3] << 8));
            Assert.Equal(micValues[i], left);
            Assert.Equal(speakerValues[i], right);
        }
    }
}

public class ConfigValidationTests
{
    [Fact]
    public void Validate_ValidConfig_NoException()
    {
        var config = new AudioCaptureConfig
        {
            MaxChunkSizeMB = 10,
            SilenceTimeoutSeconds = 60,
            SilenceThresholdDb = -50,
            SampleRate = 44100,
            OutboxDir = Path.GetTempPath()
        };
        config.Validate(); // should not throw
    }

    [Fact]
    public void Validate_NegativeChunkSize_Throws()
    {
        var config = new AudioCaptureConfig { MaxChunkSizeMB = -1 };
        Assert.Throws<ArgumentException>(() => config.Validate());
    }

    [Fact]
    public void Validate_ZeroChunkSize_Throws()
    {
        var config = new AudioCaptureConfig { MaxChunkSizeMB = 0 };
        Assert.Throws<ArgumentException>(() => config.Validate());
    }

    [Fact]
    public void Validate_ZeroSampleRate_Throws()
    {
        var config = new AudioCaptureConfig { SampleRate = 0 };
        Assert.Throws<ArgumentException>(() => config.Validate());
    }

    [Fact]
    public void Validate_PositiveSilenceThreshold_Throws()
    {
        var config = new AudioCaptureConfig { SilenceThresholdDb = 0 };
        Assert.Throws<ArgumentException>(() => config.Validate());
    }

    [Fact]
    public void Validate_ZeroSilenceTimeout_Throws()
    {
        var config = new AudioCaptureConfig { SilenceTimeoutSeconds = 0 };
        Assert.Throws<ArgumentException>(() => config.Validate());
    }

    [Fact]
    public void Validate_EmptyOutboxDir_Throws()
    {
        var config = new AudioCaptureConfig { OutboxDir = "" };
        Assert.Throws<ArgumentException>(() => config.Validate());
    }
}

public class SilenceDetectorTests
{
    [Fact]
    public void Process_LoudAudio_DoesNotFireSilence()
    {
        var time = new FakeTimeProvider();
        var detector = new SilenceDetector(-50, 5, time);
        bool fired = false;
        detector.SilenceDetected += () => fired = true;

        // Generate loud audio (amplitude ~0.5 = about -6 dB)
        byte[] loud = FakeAudioSource.GenerateTone(44100, 440, 1.0, 0.5);

        // Feed 10 seconds of loud audio with time advancing
        for (int i = 0; i < 10; i++)
        {
            time.Advance(TimeSpan.FromSeconds(1));
            detector.Process(loud);
        }

        Assert.False(fired);
    }

    [Fact]
    public void Process_SilenceForTimeout_FiresSilenceDetected()
    {
        var time = new FakeTimeProvider();
        var detector = new SilenceDetector(-50, 5, time);
        bool fired = false;
        detector.SilenceDetected += () => fired = true;

        // Generate silence
        byte[] silence = FakeAudioSource.GenerateSilence(44100, 0.1);

        // Advance past timeout (5 seconds)
        time.Advance(TimeSpan.FromSeconds(6));
        detector.Process(silence);

        Assert.True(fired);
    }

    [Fact]
    public void Process_BriefPause_DoesNotFireSilence()
    {
        var time = new FakeTimeProvider();
        var detector = new SilenceDetector(-50, 5, time);
        bool fired = false;
        detector.SilenceDetected += () => fired = true;

        // Feed loud audio to set last loud time
        byte[] loud = FakeAudioSource.GenerateTone(44100, 440, 1.0, 0.5);
        detector.Process(loud);

        // Advance only 3 seconds (less than 5s timeout)
        time.Advance(TimeSpan.FromSeconds(3));

        // Feed silence
        byte[] silence = FakeAudioSource.GenerateSilence(44100, 0.1);
        detector.Process(silence);

        Assert.False(fired);
    }

    [Fact]
    public void Process_LoudAfterSilence_ResetsTimer()
    {
        var time = new FakeTimeProvider();
        var detector = new SilenceDetector(-50, 5, time);
        bool fired = false;
        detector.SilenceDetected += () => fired = true;

        byte[] loud = FakeAudioSource.GenerateTone(44100, 440, 1.0, 0.5);
        byte[] silence = FakeAudioSource.GenerateSilence(44100, 0.1);

        // Feed loud, then partial silence (3s < 5s timeout)
        detector.Process(loud);
        time.Advance(TimeSpan.FromSeconds(3));
        detector.Process(silence);
        Assert.False(fired);

        // Feed loud again — this resets the timer
        detector.Process(loud);

        // More silence, less than timeout
        time.Advance(TimeSpan.FromSeconds(4));
        detector.Process(silence);
        Assert.False(fired);
    }

    [Fact]
    public void Reset_ClearsState()
    {
        var time = new FakeTimeProvider();
        var detector = new SilenceDetector(-50, 5, time);
        bool fired = false;
        detector.SilenceDetected += () => fired = true;

        // Fire once
        time.Advance(TimeSpan.FromSeconds(10));
        byte[] silence = FakeAudioSource.GenerateSilence(44100, 0.1);
        detector.Process(silence);
        Assert.True(fired);

        // Reset: should allow future firing again
        fired = false;
        detector.Reset();
        time.Advance(TimeSpan.FromSeconds(10));
        detector.Process(silence);
        Assert.True(fired);
    }
}

public class WavChunkWriterTests
{
    [Fact]
    public void Write_FilenameFormat_FollowsSpec()
    {
        // Test the static filename generator
        var ts = new DateTime(2026, 3, 17, 10, 30, 45, DateTimeKind.Utc);
        string name = WavChunkWriter.GenerateFilename("session-abc", 1, ts);
        Assert.Equal("session-abc_chunk-0001_20260317T103045.wav", name);
    }

    [Fact]
    public void Write_FilenameSequence_Increments()
    {
        var ts = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        string name1 = WavChunkWriter.GenerateFilename("sess", 1, ts);
        string name2 = WavChunkWriter.GenerateFilename("sess", 2, ts);
        string name3 = WavChunkWriter.GenerateFilename("sess", 3, ts);

        Assert.Contains("chunk-0001", name1);
        Assert.Contains("chunk-0002", name2);
        Assert.Contains("chunk-0003", name3);
    }

    [Fact]
    public void Write_ChunkSizeEnforcement_SplitsAtThreshold()
    {
        string outbox = Path.Combine(Path.GetTempPath(), "cortex-test-" + Guid.NewGuid());
        try
        {
            var format = new NAudio.Wave.WaveFormat(44100, 16, 2);
            // Set chunk size tiny (256 bytes of PCM data, not counting WAV header)
            long maxBytes = 256;
            using var writer = new WavChunkWriter("test-sess", outbox, maxBytes, format);

            List<string> readyChunks = [];
            writer.ChunkReady += path => readyChunks.Add(path);

            // Write 1024 bytes → should produce ~4 chunks
            byte[] data = new byte[1024];
            new Random(42).NextBytes(data);
            // Make sure it's not silence (put non-zero data)
            for (int i = 0; i < data.Length; i++) data[i] = (byte)(i % 255 + 1);

            writer.Write(data, data.Length);
            writer.Flush();

            // Should have multiple chunks
            Assert.True(readyChunks.Count >= 2, $"Expected >= 2 chunks, got {readyChunks.Count}");

            // Each chunk file should exist
            foreach (var chunk in readyChunks)
                Assert.True(File.Exists(chunk), $"Chunk file missing: {chunk}");
        }
        finally
        {
            if (Directory.Exists(outbox))
                Directory.Delete(outbox, true);
        }
    }

    [Fact]
    public void Write_CreatesOutboxDirectory()
    {
        string outbox = Path.Combine(Path.GetTempPath(), "cortex-test-" + Guid.NewGuid(), "nested", "dir");
        try
        {
            Assert.False(Directory.Exists(outbox));
            var format = new NAudio.Wave.WaveFormat(44100, 16, 2);
            using var writer = new WavChunkWriter("sess", outbox, 1024 * 1024, format);
            Assert.True(Directory.Exists(outbox));
        }
        finally
        {
            // Cleanup up two levels
            string? parent = Path.GetDirectoryName(Path.GetDirectoryName(outbox));
            if (parent != null && Directory.Exists(parent))
                Directory.Delete(parent, true);
        }
    }
}

public class SessionStateTests
{
    private static AudioCaptureConfig MakeConfig(string outbox) => new()
    {
        MaxChunkSizeMB = 10,
        SilenceTimeoutSeconds = 60,
        SilenceThresholdDb = -50,
        SampleRate = 44100,
        OutboxDir = outbox
    };

    [Fact]
    public void IsCapturing_FalseBeforeStart()
    {
        string outbox = Path.Combine(Path.GetTempPath(), "cortex-test-" + Guid.NewGuid());
        try
        {
            var mic = new FakeAudioSource();
            var speaker = new FakeAudioSource();
            using var engine = new AudioCaptureEngine(MakeConfig(outbox), mic, speaker);
            Assert.False(engine.IsCapturing);
        }
        finally { if (Directory.Exists(outbox)) Directory.Delete(outbox, true); }
    }

    [Fact]
    public void IsCapturing_TrueAfterStart()
    {
        string outbox = Path.Combine(Path.GetTempPath(), "cortex-test-" + Guid.NewGuid());
        try
        {
            var mic = new FakeAudioSource();
            var speaker = new FakeAudioSource();
            using var engine = new AudioCaptureEngine(MakeConfig(outbox), mic, speaker);
            engine.Start("sess-001");
            Assert.True(engine.IsCapturing);
            engine.Stop();
        }
        finally { if (Directory.Exists(outbox)) Directory.Delete(outbox, true); }
    }

    [Fact]
    public void IsCapturing_FalseAfterStop()
    {
        string outbox = Path.Combine(Path.GetTempPath(), "cortex-test-" + Guid.NewGuid());
        try
        {
            var mic = new FakeAudioSource();
            var speaker = new FakeAudioSource();
            using var engine = new AudioCaptureEngine(MakeConfig(outbox), mic, speaker);
            engine.Start("sess-001");
            engine.Stop();
            Assert.False(engine.IsCapturing);
        }
        finally { if (Directory.Exists(outbox)) Directory.Delete(outbox, true); }
    }

    [Fact]
    public void Start_WhenAlreadyCapturing_Throws()
    {
        string outbox = Path.Combine(Path.GetTempPath(), "cortex-test-" + Guid.NewGuid());
        try
        {
            var mic = new FakeAudioSource();
            var speaker = new FakeAudioSource();
            using var engine = new AudioCaptureEngine(MakeConfig(outbox), mic, speaker);
            engine.Start("sess-001");
            Assert.Throws<InvalidOperationException>(() => engine.Start("sess-002"));
            engine.Stop();
        }
        finally { if (Directory.Exists(outbox)) Directory.Delete(outbox, true); }
    }
}
