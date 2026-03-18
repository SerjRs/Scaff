# Generate speech fixture for Whisper E2E tests.
# Uses Windows SpeechSynthesizer to produce a mono WAV, then
# calls a Node helper to create a stereo 16kHz version.

Add-Type -AssemblyName System.Speech

$outDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$monoTmp = Join-Path $outDir "_tmp-mono-speech.wav"

# 1. Synthesize speech to WAV (default rate = 22050 Hz mono 16-bit)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = -1  # slightly slower for clarity
$synth.SetOutputToWaveFile($monoTmp)
$synth.Speak("The meeting is scheduled for Tuesday at three PM. Action item: review the quarterly report by Friday.")
$synth.Dispose()

Write-Host "Generated mono TTS: $monoTmp"

# 2. Convert to stereo 16kHz via Node helper
$helperScript = Join-Path $outDir "make-stereo-16k.mjs"
node $helperScript $monoTmp (Join-Path $outDir "test-speech-10s.wav")

# 3. Clean up temp
Remove-Item $monoTmp -ErrorAction SilentlyContinue

Write-Host "Done: test-speech-10s.wav"
