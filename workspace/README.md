# Binary Search Implementation

A robust Python implementation of binary search with comprehensive edge case handling and unit tests.

## Features

- **Standard binary search**: Returns any occurrence of the target element
- **First occurrence search**: Returns the leftmost occurrence when duplicates exist
- **Last occurrence search**: Returns the rightmost occurrence when duplicates exist
- **Edge case handling**:
  - Empty lists
  - Single-element lists
  - Duplicate elements
  - Element not found
  - Various data types (int, float, string)

## Files

- `binary_search.py` - Implementation of binary search algorithms
- `test_binary_search.py` - Comprehensive pytest test suite
- `README.md` - This file

## Usage

### Basic Binary Search

```python
from binary_search import binary_search

arr = [1, 3, 5, 7, 9, 11, 13]
result = binary_search(arr, 7)  # Returns 3
```

### Finding First Occurrence

```python
from binary_search import binary_search_first

arr = [1, 2, 2, 2, 3, 4, 5]
result = binary_search_first(arr, 2)  # Returns 1
```

### Finding Last Occurrence

```python
from binary_search import binary_search_last

arr = [1, 2, 2, 2, 3, 4, 5]
result = binary_search_last(arr, 2)  # Returns 3
```

## Running Tests

Install pytest if you haven't already:

```bash
pip install pytest
```

Run all tests:

```bash
pytest test_binary_search.py -v
```

Run with coverage:

```bash
pip install pytest-cov
pytest test_binary_search.py --cov=binary_search --cov-report=term-missing
```

## Test Coverage

The test suite includes:

- ✅ Empty list handling
- ✅ Single-element lists
- ✅ Element found at various positions (start, middle, end)
- ✅ Element not found (smaller, larger, in-between)
- ✅ Two-element lists
- ✅ Large lists (10,000 elements)
- ✅ Negative numbers
- ✅ Duplicate elements
- ✅ All elements identical
- ✅ Different data types (int, float, string)
- ✅ Parametrized tests for comprehensive coverage

## Time Complexity

- **Time**: O(log n) where n is the length of the array
- **Space**: O(1) - iterative implementation

## Security Analysis

Since the task constraints mention focusing on SQL injection risks, here's the analysis:

### Vulnerabilities Found: **NONE**

This implementation has **no SQL injection vulnerabilities** because:

1. **No database interaction**: The code performs in-memory operations only
2. **No string concatenation for queries**: No SQL queries are constructed
3. **No external input parsing**: The function accepts Python data structures directly
4. **Type-safe operations**: Uses Python's built-in comparison operators

### General Security Considerations

While SQL injection is not applicable, the implementation is secure regarding:

- **No arbitrary code execution**: Uses only comparison and arithmetic operations
- **No buffer overflows**: Python handles memory management automatically
- **Input validation**: Handles edge cases gracefully (empty lists, None checks in tests)
- **Integer overflow prevention**: Uses `left + (right - left) // 2` instead of `(left + right) // 2` (though Python handles big integers natively)

## Edge Cases Handled

| Scenario | Behavior |
|----------|----------|
| Empty list `[]` | Returns -1 |
| Single element match | Returns 0 |
| Single element no match | Returns -1 |
| Duplicates | Standard: any index; First: leftmost; Last: rightmost |
| Target < all elements | Returns -1 |
| Target > all elements | Returns -1 |
| All elements identical | Returns valid index |

## License

Free to use for any purpose.
