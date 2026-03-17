//! Stereo interleaving: two mono streams → one stereo stream.
//! Left channel = mic, Right channel = speakers.

/// Interleave two mono sample buffers into a stereo buffer.
/// If buffers differ in length, the shorter one is zero-padded.
///
/// Output layout: [mic_0, spk_0, mic_1, spk_1, ...]
pub fn interleave_stereo(mic: &[f32], speakers: &[f32]) -> Vec<f32> {
    let len = mic.len().max(speakers.len());
    let mut out = Vec::with_capacity(len * 2);
    for i in 0..len {
        let l = if i < mic.len() { mic[i] } else { 0.0 };
        let r = if i < speakers.len() { speakers[i] } else { 0.0 };
        out.push(l);
        out.push(r);
    }
    out
}

/// Convert f32 samples (-1.0..1.0) to i16 for WAV writing.
pub fn f32_to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|&s| {
            let clamped = s.clamp(-1.0, 1.0);
            (clamped * i16::MAX as f32) as i16
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_interleave_equal_length() {
        let mic = vec![0.1, 0.2, 0.3];
        let spk = vec![0.4, 0.5, 0.6];
        let stereo = interleave_stereo(&mic, &spk);
        assert_eq!(stereo, vec![0.1, 0.4, 0.2, 0.5, 0.3, 0.6]);
    }

    #[test]
    fn test_interleave_mic_shorter() {
        let mic = vec![0.1];
        let spk = vec![0.4, 0.5, 0.6];
        let stereo = interleave_stereo(&mic, &spk);
        assert_eq!(stereo, vec![0.1, 0.4, 0.0, 0.5, 0.0, 0.6]);
    }

    #[test]
    fn test_interleave_speakers_shorter() {
        let mic = vec![0.1, 0.2, 0.3];
        let spk = vec![0.4];
        let stereo = interleave_stereo(&mic, &spk);
        assert_eq!(stereo, vec![0.1, 0.4, 0.2, 0.0, 0.3, 0.0]);
    }

    #[test]
    fn test_interleave_empty() {
        let stereo = interleave_stereo(&[], &[]);
        assert!(stereo.is_empty());
    }

    #[test]
    fn test_interleave_one_empty() {
        let mic = vec![0.5, -0.5];
        let stereo = interleave_stereo(&mic, &[]);
        assert_eq!(stereo, vec![0.5, 0.0, -0.5, 0.0]);
    }

    #[test]
    fn test_mic_on_left_speakers_on_right() {
        let mic = vec![1.0];
        let spk = vec![-1.0];
        let stereo = interleave_stereo(&mic, &spk);
        // Index 0 (left) = mic, Index 1 (right) = speakers
        assert_eq!(stereo[0], 1.0);
        assert_eq!(stereo[1], -1.0);
    }

    #[test]
    fn test_f32_to_i16_conversion() {
        let samples = vec![0.0, 1.0, -1.0, 0.5, -0.5];
        let converted = f32_to_i16(&samples);
        assert_eq!(converted[0], 0);
        assert_eq!(converted[1], i16::MAX);
        assert_eq!(converted[2], -i16::MAX);
        assert!(converted[3] > 0);
        assert!(converted[4] < 0);
    }

    #[test]
    fn test_f32_to_i16_clamps() {
        let samples = vec![2.0, -2.0];
        let converted = f32_to_i16(&samples);
        assert_eq!(converted[0], i16::MAX);
        assert_eq!(converted[1], -i16::MAX);
    }
}
