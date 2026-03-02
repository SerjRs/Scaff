"""
Unit tests for binary search implementations.
"""

import pytest
from binary_search import binary_search, binary_search_first, binary_search_last


class TestBinarySearch:
    """Test cases for standard binary search."""
    
    def test_empty_list(self):
        """Test binary search on an empty list."""
        assert binary_search([], 5) == -1
    
    def test_single_element_found(self):
        """Test binary search on a single-element list where element is found."""
        assert binary_search([5], 5) == 0
    
    def test_single_element_not_found(self):
        """Test binary search on a single-element list where element is not found."""
        assert binary_search([5], 3) == -1
    
    def test_element_found_in_middle(self):
        """Test finding an element in the middle of the list."""
        arr = [1, 3, 5, 7, 9, 11, 13]
        assert binary_search(arr, 7) == 3
    
    def test_element_found_at_start(self):
        """Test finding the first element."""
        arr = [1, 3, 5, 7, 9, 11, 13]
        assert binary_search(arr, 1) == 0
    
    def test_element_found_at_end(self):
        """Test finding the last element."""
        arr = [1, 3, 5, 7, 9, 11, 13]
        assert binary_search(arr, 13) == 6
    
    def test_element_not_found_too_small(self):
        """Test searching for an element smaller than all elements."""
        arr = [1, 3, 5, 7, 9]
        assert binary_search(arr, 0) == -1
    
    def test_element_not_found_too_large(self):
        """Test searching for an element larger than all elements."""
        arr = [1, 3, 5, 7, 9]
        assert binary_search(arr, 10) == -1
    
    def test_element_not_found_in_middle(self):
        """Test searching for an element that would be in the middle but isn't there."""
        arr = [1, 3, 5, 7, 9]
        assert binary_search(arr, 6) == -1
    
    def test_two_elements_found_first(self):
        """Test with two elements, finding the first."""
        assert binary_search([1, 3], 1) == 0
    
    def test_two_elements_found_second(self):
        """Test with two elements, finding the second."""
        assert binary_search([1, 3], 3) == 1
    
    def test_two_elements_not_found(self):
        """Test with two elements, target not present."""
        assert binary_search([1, 3], 2) == -1
    
    def test_large_list(self):
        """Test with a large sorted list."""
        arr = list(range(0, 10000, 2))  # [0, 2, 4, 6, ..., 9998]
        assert binary_search(arr, 5000) == 2500
        assert binary_search(arr, 5001) == -1
    
    def test_negative_numbers(self):
        """Test with negative numbers."""
        arr = [-10, -5, -2, 0, 3, 7, 11]
        assert binary_search(arr, -5) == 1
        assert binary_search(arr, 0) == 3
    
    def test_all_same_elements(self):
        """Test with all duplicate elements."""
        arr = [5, 5, 5, 5, 5]
        assert binary_search(arr, 5) in [0, 1, 2, 3, 4]
        assert binary_search(arr, 3) == -1


class TestBinarySearchWithDuplicates:
    """Test cases specifically for handling duplicate elements."""
    
    def test_duplicates_present(self):
        """Test that binary_search finds one occurrence of duplicates."""
        arr = [1, 2, 2, 2, 3, 4, 5]
        result = binary_search(arr, 2)
        assert result in [1, 2, 3]  # Any occurrence is valid
    
    def test_find_first_occurrence(self):
        """Test finding the first occurrence of a duplicate."""
        arr = [1, 2, 2, 2, 3, 4, 5]
        assert binary_search_first(arr, 2) == 1
    
    def test_find_last_occurrence(self):
        """Test finding the last occurrence of a duplicate."""
        arr = [1, 2, 2, 2, 3, 4, 5]
        assert binary_search_last(arr, 2) == 3
    
    def test_first_and_last_single_element(self):
        """Test first/last functions when element appears once."""
        arr = [1, 2, 3, 4, 5]
        assert binary_search_first(arr, 3) == 2
        assert binary_search_last(arr, 3) == 2
    
    def test_first_occurrence_at_start(self):
        """Test finding first occurrence when duplicates start at index 0."""
        arr = [5, 5, 5, 6, 7]
        assert binary_search_first(arr, 5) == 0
    
    def test_last_occurrence_at_end(self):
        """Test finding last occurrence when duplicates end at last index."""
        arr = [1, 2, 5, 5, 5]
        assert binary_search_last(arr, 5) == 4
    
    def test_all_duplicates_first(self):
        """Test finding first when all elements are the same."""
        arr = [7, 7, 7, 7]
        assert binary_search_first(arr, 7) == 0
    
    def test_all_duplicates_last(self):
        """Test finding last when all elements are the same."""
        arr = [7, 7, 7, 7]
        assert binary_search_last(arr, 7) == 3
    
    def test_duplicates_not_found_first(self):
        """Test first occurrence search when element not present."""
        arr = [1, 2, 2, 2, 5]
        assert binary_search_first(arr, 3) == -1
    
    def test_duplicates_not_found_last(self):
        """Test last occurrence search when element not present."""
        arr = [1, 2, 2, 2, 5]
        assert binary_search_last(arr, 3) == -1


class TestEdgeCases:
    """Additional edge case tests."""
    
    def test_none_list(self):
        """Test behavior with None as the list."""
        with pytest.raises((TypeError, AttributeError)):
            binary_search(None, 5)
    
    def test_string_elements(self):
        """Test with strings (comparable elements)."""
        arr = ['apple', 'banana', 'cherry', 'date']
        assert binary_search(arr, 'banana') == 1
        assert binary_search(arr, 'fig') == -1
    
    def test_float_elements(self):
        """Test with floating-point numbers."""
        arr = [1.1, 2.5, 3.7, 4.9, 5.5]
        assert binary_search(arr, 3.7) == 2
        assert binary_search(arr, 3.8) == -1
    
    def test_mixed_numeric_types(self):
        """Test with mixed int and float (Python handles this well)."""
        arr = [1, 2.5, 3, 4.5, 5]
        assert binary_search(arr, 2.5) == 1
        assert binary_search(arr, 3) == 2


# Parametrized tests for comprehensive coverage
@pytest.mark.parametrize("arr,target,expected", [
    ([], 1, -1),
    ([1], 1, 0),
    ([1], 2, -1),
    ([1, 2, 3], 2, 1),
    ([1, 2, 3], 4, -1),
    ([1, 3, 5, 7, 9], 1, 0),
    ([1, 3, 5, 7, 9], 9, 4),
    ([1, 3, 5, 7, 9], 5, 2),
    ([1, 3, 5, 7, 9], 2, -1),
    ([1, 3, 5, 7, 9], 8, -1),
])
def test_binary_search_parametrized(arr, target, expected):
    """Parametrized test for various inputs."""
    assert binary_search(arr, target) == expected
