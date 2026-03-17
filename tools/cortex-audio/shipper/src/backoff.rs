/// Exponential backoff calculator with jitter-free capped delays.
pub struct Backoff {
    initial_ms: u64,
    max_ms: u64,
}

impl Backoff {
    pub fn new(initial_ms: u64, max_ms: u64) -> Self {
        assert!(initial_ms > 0, "initial_ms must be > 0");
        assert!(max_ms >= initial_ms, "max_ms must be >= initial_ms");
        Self { initial_ms, max_ms }
    }

    /// Returns the delay in milliseconds for the given attempt (0-based).
    pub fn delay_ms(&self, attempt: u32) -> u64 {
        let delay = self.initial_ms.saturating_mul(1u64.checked_shl(attempt).unwrap_or(u64::MAX));
        delay.min(self.max_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exponential_sequence() {
        let b = Backoff::new(1000, 60_000);
        assert_eq!(b.delay_ms(0), 1_000);
        assert_eq!(b.delay_ms(1), 2_000);
        assert_eq!(b.delay_ms(2), 4_000);
        assert_eq!(b.delay_ms(3), 8_000);
        assert_eq!(b.delay_ms(4), 16_000);
        assert_eq!(b.delay_ms(5), 32_000);
        assert_eq!(b.delay_ms(6), 60_000); // capped
    }

    #[test]
    fn caps_at_max() {
        let b = Backoff::new(1000, 5_000);
        assert_eq!(b.delay_ms(0), 1_000);
        assert_eq!(b.delay_ms(1), 2_000);
        assert_eq!(b.delay_ms(2), 4_000);
        assert_eq!(b.delay_ms(3), 5_000); // capped
        assert_eq!(b.delay_ms(10), 5_000);
    }

    #[test]
    fn large_attempt_saturates() {
        let b = Backoff::new(1000, 60_000);
        // Very large attempt should not panic, just cap
        assert_eq!(b.delay_ms(63), 60_000);
        assert_eq!(b.delay_ms(100), 60_000);
    }

    #[test]
    #[should_panic(expected = "initial_ms must be > 0")]
    fn rejects_zero_initial() {
        Backoff::new(0, 1000);
    }

    #[test]
    #[should_panic(expected = "max_ms must be >= initial_ms")]
    fn rejects_max_less_than_initial() {
        Backoff::new(5000, 1000);
    }
}
