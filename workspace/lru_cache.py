"""Thread-safe LRU cache with TTL support."""

import threading
import time
from collections import OrderedDict
from typing import Any, Hashable, Optional


class TTLLRUCache:
    """A thread-safe Least Recently Used cache with per-entry Time-To-Live.

    Args:
        capacity: Maximum number of entries. Must be >= 1.
        default_ttl: Default time-to-live in seconds. None means no expiry.

    Example:
        >>> cache = TTLLRUCache(capacity=128, default_ttl=60.0)
        >>> cache.put("key", "value")
        >>> cache.get("key")
        'value'
    """

    def __init__(self, capacity: int = 128, default_ttl: Optional[float] = None) -> None:
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self._capacity: int = capacity
        self._default_ttl: Optional[float] = default_ttl
        self._lock: threading.Lock = threading.Lock()
        # Maps key -> (value, expiry_timestamp | None)
        self._store: OrderedDict[Hashable, tuple[Any, Optional[float]]] = OrderedDict()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, key: Hashable, default: Any = None) -> Any:
        """Retrieve a value by key, returning *default* if missing or expired.

        Accessing a live entry promotes it to most-recently-used.
        """
        with self._lock:
            if key not in self._store:
                return default
            value, expiry = self._store[key]
            if expiry is not None and time.monotonic() > expiry:
                del self._store[key]
                return default
            self._store.move_to_end(key)
            return value

    def put(self, key: Hashable, value: Any, ttl: Optional[float] = ...) -> None:  # type: ignore[assignment]
        """Insert or update an entry.

        Args:
            key: Cache key (must be hashable).
            value: Arbitrary value to store.
            ttl: Per-entry TTL in seconds. Pass ``None`` for no expiry.
                 Omit (or use the sentinel default) to use the cache-wide
                 ``default_ttl``.
        """
        # Resolve sentinel: ellipsis means "use default_ttl"
        effective_ttl: Optional[float] = self._default_ttl if ttl is ... else ttl
        expiry: Optional[float] = (
            time.monotonic() + effective_ttl if effective_ttl is not None else None
        )
        with self._lock:
            if key in self._store:
                self._store.move_to_end(key)
            self._store[key] = (value, expiry)
            if len(self._store) > self._capacity:
                self._store.popitem(last=False)

    def delete(self, key: Hashable) -> bool:
        """Remove *key* from the cache. Returns ``True`` if it was present."""
        with self._lock:
            if key in self._store:
                del self._store[key]
                return True
            return False

    def clear(self) -> None:
        """Remove all entries."""
        with self._lock:
            self._store.clear()

    def __len__(self) -> int:
        """Return the number of entries (including possibly-expired ones)."""
        return len(self._store)

    def __contains__(self, key: Hashable) -> bool:
        """Check membership without promoting the entry."""
        with self._lock:
            if key not in self._store:
                return False
            _, expiry = self._store[key]
            if expiry is not None and time.monotonic() > expiry:
                del self._store[key]
                return False
            return True

    def purge_expired(self) -> int:
        """Remove all expired entries. Returns the count of purged items."""
        now = time.monotonic()
        purged = 0
        with self._lock:
            expired_keys = [
                k for k, (_, exp) in self._store.items()
                if exp is not None and now > exp
            ]
            for k in expired_keys:
                del self._store[k]
                purged += 1
        return purged
