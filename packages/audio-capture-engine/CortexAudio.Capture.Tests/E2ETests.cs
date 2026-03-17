using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using Xunit;

namespace CortexAudio.Capture.Tests;

/// <summary>
/// End-to-end tests for the AudioCaptureEngine.
/// Uses FakeAudioSource to inject audio without real WASAPI devices.
/// </summary>
public class AudioCaptureE2ETests : IDisposable
{
    private readonly string _outbox;

    public AudioCaptureE2ETests()
    {
        _outbox = Path.Combine(Path.GetTempPath(), "cortex-e2e-" + Guid.NewGuid());
        Directory.CreateDirectory(_outbox);
    }

    public void Dispose()
    {
        if (Directory.Exists(_outbox))
            Directory.Delete(_outbox, true);
    }

    private AudioCaptureConfig MakeConfig(
        int maxChunkMB = 10,
        int silenceTimeoutSec = 60,
        double silenceThresholdDb = -50) => new()
    {
        MaxChunkSizeMB = maxChunkMB,
        SilenceTimeoutSeconds = silenceTimeoutSec,
        SilenceThresholdDb = silenceThresholdDb,
        SampleRate = 44100,
        OutboxDir = _outbox
    };

    // ------------------------------------------------------------------
    // E2E 1: Full capture cycle
    // ------------------------------------------------------------------
    [Fact]
    public void FullCaptureCycle_ChunkFilesAppearWithCorrectFormatAndNaming()
    {
        var mic = new FakeAudioSource();
        var speaker = new FakeAudioSource();
        var config = MakeConfig();

        using var engine = new AudioCaptureEngine(config, mic, speaker);
        var chunks = new List<string>();
        engine.ChunkReady += p => chunks.Add(p);

        string sessionId = "session-abc123";
        engine.Start(sessionId);

        // Feed audio through both sources
        byte[] tone = FakeAudioSource.GenerateTone(44100, 440, 1.0, 0.5);
        mic.Feed(tone);
        speaker.Feed(tone);

        engine.Stop();

        // At least one chunk should have been produced
        Assert.NotEmpty(chunks);

        // Verify each chunk file: naming and WAV format
        foreach (var chunkPath in chunks)
        {
            Assert.True(File.Exists(chunkPath), $"Missing: {chunkPath}");

            string filename = Path.GetFileName(chunkPath);

            // Naming pattern: {sessionId}_chunk-{sequence}_{timestamp}.wav
            // timestamp format: yyyyMMddTHHmmss  (8 digits + T + 6 digits)
            var pattern = $@"^{Regex.Escape(sessionId)}_chunk-(\d{{4}})_(\d{{8}}T\d{{6}})\.wav$";
            Assert.Matches(pattern, filename);

            // WAV format checks
            byte[] bytes = File.ReadAllBytes(chunkPath);
            Assert.True(bytes.Length > 44, "WAV file too small");

            // RIFF header
            Assert.Equal('R', (char)bytes[0]);
            Assert.Equal('I', (char)bytes[1]);
            Assert.Equal('F', (char)bytes[2]);
            Assert.Equal('F', (char)bytes[3]);

            // WAVE marker
            Assert.Equal('W', (char)bytes[8]);
            Assert.Equal('A', (char)bytes[9]);
            Assert.Equal('V', (char)bytes[10]);
            Assert.Equal('E', (char)bytes[11]);

            // Channels (offset 22, 2 bytes) should be 2 (stereo)
            short channels = (short)(bytes[22] | (bytes[23] << 8));
            Assert.Equal(2, channels);
        }
    }

    // ------------------------------------------------------------------
    // E2E 2: Silence auto-stop
    // ------------------------------------------------------------------
    [Fact]
    public void SilenceAutoStop_SessionEndFiresAndNoMoreChunksWritten()
    {
        var time = new FakeTimeProvider();
        var mic = new FakeAudioSource();
        var speaker = new FakeAudioSource();
        var config = MakeConfig(silenceTimeoutSec: 5);

        using var engine = new AudioCaptureEngine(config, mic, speaker, time);
        bool sessionEnded = false;
        var chunksAfterEnd = new List<string>();

        engine.SessionEnd += () => sessionEnded = true;

        string sessionId = "sess-silence";
        engine.Start(sessionId);

        // Feed some real audio first
        byte[] tone = FakeAudioSource.GenerateTone(44100, 440, 0.5, 0.5);
        mic.Feed(tone);
        speaker.Feed(tone);

        // Now feed silence and advance time past timeout
        byte[] silence = FakeAudioSource.GenerateSilence(44100, 0.1);
        time.Advance(TimeSpan.FromSeconds(6)); // > 5s timeout
        mic.Feed(silence);

        // Give a moment for the event to propagate synchronously
        Thread.Sleep(50);

        Assert.True(sessionEnded, "SessionEnd should have fired");
        Assert.False(engine.IsCapturing, "Engine should have stopped");

        // No chunks should be written after session end
        engine.ChunkReady += p => chunksAfterEnd.Add(p);
        mic.Feed(tone);
        Assert.Empty(chunksAfterEnd);
    }

    // ------------------------------------------------------------------
    // E2E 3: Multi-chunk session
    // ------------------------------------------------------------------
    [Fact]
    public void MultiChunkSession_AllChunksSequentialNoGapsNoOverlaps()
    {
        var mic = new FakeAudioSource();
        var speaker = new FakeAudioSource();

        // Very small chunk size to force multiple chunks (1 KB of PCM)
        const long chunkBytes = 1024;
        var config = new AudioCaptureConfig
        {
            MaxChunkSizeMB = 1, // will override via custom approach
            SilenceTimeoutSeconds = 60,
            SilenceThresholdDb = -50,
            SampleRate = 44100,
            OutboxDir = _outbox
        };

        // Use a writer directly to test multi-chunk with byte-level control
        var format = new NAudio.Wave.WaveFormat(44100, 16, 2);
        using var writer = new WavChunkWriter("multi-sess", _outbox, chunkBytes, format);

        var chunks = new List<string>();
        writer.ChunkReady += p => chunks.Add(p);

        // Write enough data to produce at least 3 chunks (3 * 1024 = 3072 bytes)
        byte[] block = new byte[3072];
        for (int i = 0; i < block.Length; i++) block[i] = (byte)((i % 254) + 1); // non-zero
        writer.Write(block, block.Length);
        writer.Flush();

        Assert.True(chunks.Count >= 3, $"Expected >= 3 chunks, got {chunks.Count}");

        // Verify sequence numbers are consecutive (0001, 0002, 0003...)
        var seqPattern = new Regex(@"chunk-(\d{4})_");
        var sequences = new List<int>();
        foreach (var c in chunks)
        {
            var m = seqPattern.Match(Path.GetFileName(c));
            Assert.True(m.Success, $"Could not extract sequence from {c}");
            sequences.Add(int.Parse(m.Groups[1].Value));
        }

        for (int i = 0; i < sequences.Count; i++)
            Assert.Equal(i + 1, sequences[i]);

        // All files should exist
        foreach (var c in chunks)
            Assert.True(File.Exists(c), $"Missing chunk: {c}");
    }

    // ------------------------------------------------------------------
    // E2E 4: Resume after stop — new sessionId, sequence resets
    // ------------------------------------------------------------------
    [Fact]
    public void ResumeAfterStop_NewSessionIdAndSequenceResets()
    {
        var mic1 = new FakeAudioSource();
        var speaker1 = new FakeAudioSource();
        var config = MakeConfig();

        // Session 1
        using (var engine1 = new AudioCaptureEngine(config, mic1, speaker1))
        {
            var sess1Chunks = new List<string>();
            engine1.ChunkReady += p => sess1Chunks.Add(p);

            engine1.Start("session-001");
            byte[] tone = FakeAudioSource.GenerateTone(44100, 440, 1.0, 0.5);
            mic1.Feed(tone);
            speaker1.Feed(tone);
            engine1.Stop();

            Assert.Equal("session-001", engine1.CurrentSessionId);
        }

        // Session 2 — fresh engine, new sessionId
        var mic2 = new FakeAudioSource();
        var speaker2 = new FakeAudioSource();

        using var engine2 = new AudioCaptureEngine(config, mic2, speaker2);
        var sess2Chunks = new List<string>();
        engine2.ChunkReady += p => sess2Chunks.Add(p);

        engine2.Start("session-002");
        byte[] tone2 = FakeAudioSource.GenerateTone(44100, 440, 1.0, 0.5);
        mic2.Feed(tone2);
        speaker2.Feed(tone2);
        engine2.Stop();

        Assert.Equal("session-002", engine2.CurrentSessionId);

        // Chunk filenames in session 2 should reference "session-002" not "session-001"
        foreach (var c in sess2Chunks)
        {
            Assert.Contains("session-002", Path.GetFileName(c));
            Assert.DoesNotContain("session-001", Path.GetFileName(c));
        }

        // If session 2 produced any chunks, first sequence should be 0001 (reset)
        if (sess2Chunks.Count > 0)
        {
            var seqPattern = new Regex(@"chunk-(\d{4})_");
            var m = seqPattern.Match(Path.GetFileName(sess2Chunks[0]));
            if (m.Success)
                Assert.Equal(1, int.Parse(m.Groups[1].Value));
        }
    }

    // ------------------------------------------------------------------
    // E2E 5: Outbox directory created if not exists
    // ------------------------------------------------------------------
    [Fact]
    public void OutboxDirectory_CreatedIfNotExists()
    {
        string deepOutbox = Path.Combine(Path.GetTempPath(), "cortex-e2e-newdir-" + Guid.NewGuid(), "sub", "deep");
        try
        {
            Assert.False(Directory.Exists(deepOutbox));
            var config = new AudioCaptureConfig
            {
                MaxChunkSizeMB = 10,
                SilenceTimeoutSeconds = 60,
                SilenceThresholdDb = -50,
                SampleRate = 44100,
                OutboxDir = deepOutbox
            };
            var mic = new FakeAudioSource();
            var speaker = new FakeAudioSource();
            using var engine = new AudioCaptureEngine(config, mic, speaker);
            engine.Start("sess-dir-test");
            engine.Stop();
            Assert.True(Directory.Exists(deepOutbox));
        }
        finally
        {
            // deepOutbox = %TEMP%\cortex-e2e-newdir-{Guid}\sub\deep
            // Go up exactly 2 levels to delete the Guid-named root folder
            string? guidRoot = Path.GetDirectoryName(Path.GetDirectoryName(deepOutbox));
            if (guidRoot != null && Directory.Exists(guidRoot))
            {
                try { Directory.Delete(guidRoot, true); }
                catch (IOException) { /* ignore if locked — e.g. by coverlet */ }
            }
        }
    }
}
