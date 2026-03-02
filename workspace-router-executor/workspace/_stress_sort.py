import random

# Generate 100 random integers between 1-10000
numbers = [random.randint(1, 10000) for _ in range(100)]

# Bubble sort implementation
def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr

# Sort the numbers
sorted_numbers = bubble_sort(numbers)

# Print first 10 and last 10
print("First 10 sorted values:")
print(sorted_numbers[:10])
print("\nLast 10 sorted values:")
print(sorted_numbers[-10:])
