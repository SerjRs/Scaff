using NAudio.Wave;

namespace CortexAudio.Capture;

/// <summary>
/// Writes stereo PCM audio to WAV files, splitting into size-based chunks.
/// File naming: {sessionId}_chunk-{sequence}_{timestamp}.wav
/// </summary>
public class WavChunkWriter : IDisposable
{
    private readonly string _sessionId;
    private readonly string _outboxDir;
    private readonly long _maxChunkBytes;
    private readonly WaveFormat _format;
    private WaveFileWriter? _writer;
    private int _sequence;
    private long _currentSize;

    public event Action<string>? ChunkReady;

    public WavChunkWriter(string sessionId, string outboxDir, long maxChunkBytes, WaveFormat format)
    {
        _sessionId = sessionId;
        _outboxDir = outboxDir;
        _maxChunkBytes = maxChunkBytes;
        _format = format;
        _sequence = 0;

        Directory.CreateDirectory(_outboxDir);
    }

    public int CurrentSequence => _sequence;

    public void Write(byte[] stereoData, int count)
    {
        if (count <= 0) return;

        int offset = 0;
        while (offset < count)
        {
            if (_writer == null)
            {
                OpenNextChunk();
            }

            long remaining = _maxChunkBytes - _currentSize;
            int toWrite = (int)Math.Min(remaining, count - offset);

            _writer!.Write(stereoData, offset, toWrite);
            _currentSize += toWrite;
            offset += toWrite;

            if (_currentSize >= _maxChunkBytes)
            {
                CloseCurrentChunk();
            }
        }
    }

    public void Flush()
    {
        CloseCurrentChunk();
    }

    public void Dispose()
    {
        CloseCurrentChunk();
    }

    private void OpenNextChunk()
    {
        _sequence++;
        string timestamp = DateTime.UtcNow.ToString("yyyyMMddTHHmmss");
        string filename = $"{_sessionId}_chunk-{_sequence:D4}_{timestamp}.wav";
        string path = Path.Combine(_outboxDir, filename);
        _writer = new WaveFileWriter(path, _format);
        _currentSize = 0;
    }

    private void CloseCurrentChunk()
    {
        if (_writer == null) return;

        string path = _writer.Filename;
        _writer.Dispose();
        _writer = null;
        _currentSize = 0;

        // Only emit if the file has actual data
        if (new FileInfo(path).Length > 44) // 44 = WAV header size
        {
            ChunkReady?.Invoke(path);
        }
    }

    /// <summary>
    /// Generates a chunk filename for testing purposes.
    /// </summary>
    public static string GenerateFilename(string sessionId, int sequence, DateTime timestamp)
    {
        string ts = timestamp.ToString("yyyyMMddTHHmmss");
        return $"{sessionId}_chunk-{sequence:D4}_{ts}.wav";
    }
}
