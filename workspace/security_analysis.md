# Security Analysis: Hacker News Scraper

## Overview
Analysis of `scrape_hackernews.py` for security vulnerabilities, with focus on SQL injection risks per requirements.

## SQL Injection Analysis

**Finding:** ✅ **No SQL injection vulnerabilities present**

**Reasoning:**
- The script does not use any database connections
- No SQL queries are constructed or executed
- Data is only written to JSON files, not databases
- No user input is incorporated into SQL statements

## Other Security Vulnerabilities Found

### 1. ⚠️ Path Traversal Risk (Low Severity)

**Location:** `save_to_json()` function
```python
def save_to_json(data, filename='hackernews_titles.json'):
    with open(filename, 'w', encoding='utf-8') as f:
```

**Vulnerability:**
If `filename` parameter is user-controlled, an attacker could write to arbitrary file locations:
```python
# Malicious usage example:
save_to_json(data, '../../../etc/passwd')
```

**Fix:**
```python
import os

def save_to_json(data, filename='hackernews_titles.json'):
    # Sanitize filename - remove path components
    safe_filename = os.path.basename(filename)
    
    # Ensure we're writing to current directory only
    if not safe_filename or safe_filename.startswith('.'):
        safe_filename = 'hackernews_titles.json'
    
    try:
        with open(safe_filename, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
```

**Note:** In current implementation, `filename` is hardcoded in `main()`, so risk is minimal.

---

### 2. ⚠️ HTML Injection / XSS Risk (Low Severity)

**Location:** `HackerNewsParser.handle_data()`
```python
def handle_data(self, data):
    if self.in_title_link:
        self.current_story['title'] = data.strip()
```

**Vulnerability:**
Malicious HTML/JavaScript in story titles is stored without sanitization. If the JSON output is later displayed in a web interface without escaping, it could lead to XSS.

**Example malicious title:**
```html
<script>alert('XSS')</script>
```

**Fix:**
```python
import html

def handle_data(self, data):
    if self.in_title_link:
        # Escape HTML entities for safety
        self.current_story['title'] = html.escape(data.strip())
```

**Alternative:** If you want to preserve the raw data, document that JSON consumers must escape before rendering.

---

### 3. ⚠️ Server-Side Request Forgery (SSRF) Risk (Medium Severity)

**Location:** `scrape_hackernews()` function
```python
url = 'https://news.ycombinator.com/'
```

**Vulnerability:**
The URL is hardcoded, but if this were made configurable, an attacker could make the script fetch internal resources:
```python
# Malicious usage if URL becomes a parameter:
scrape_hackernews('http://localhost:22')  # Scan internal ports
scrape_hackernews('http://169.254.169.254/latest/meta-data/')  # AWS metadata
```

**Fix (if URL becomes configurable):**
```python
from urllib.parse import urlparse

ALLOWED_DOMAINS = ['news.ycombinator.com']

def scrape_hackernews(url='https://news.ycombinator.com/'):
    # Validate URL
    parsed = urlparse(url)
    
    if parsed.netloc not in ALLOWED_DOMAINS:
        raise ValueError(f"Domain not allowed: {parsed.netloc}")
    
    if parsed.scheme not in ['https']:
        raise ValueError(f"Only HTTPS is allowed")
```

**Current Status:** ✅ Safe - URL is hardcoded.

---

### 4. ℹ️ Timeout Configuration (Best Practice)

**Location:** `urllib.request.urlopen()`
```python
with urllib.request.urlopen(request, timeout=10) as response:
```

**Good Practice:** ✅ Timeout is set (10 seconds) - prevents indefinite hanging.

---

### 5. ℹ️ Exception Information Disclosure (Low Severity)

**Location:** Error handling blocks
```python
except Exception as e:
    print(f"Unexpected error: {e}")
```

**Vulnerability:**
Detailed error messages could leak system information in production environments.

**Fix for production:**
```python
import logging

except Exception as e:
    logging.error(f"Scraping failed: {e}", exc_info=True)
    print("An error occurred while scraping. Check logs for details.")
```

---

## Summary

| Vulnerability | Severity | Current Risk | Recommendation |
|--------------|----------|--------------|----------------|
| SQL Injection | N/A | None | No SQL used |
| Path Traversal | Low | Minimal | Sanitize if filename becomes user input |
| HTML Injection/XSS | Low | Low | Escape HTML entities or document consumer responsibility |
| SSRF | Medium | None | Keep URL hardcoded or add validation |
| Info Disclosure | Low | Low | Use proper logging in production |

## Recommendations

1. **Keep current design** - hardcoded URL and filename minimize attack surface
2. **If extending functionality:**
   - Sanitize all file paths
   - Validate and whitelist URLs
   - Escape HTML content
3. **For production use:**
   - Add proper logging instead of print statements
   - Implement rate limiting to avoid overwhelming HN servers
   - Add retry logic with exponential backoff

## Conclusion

The script is **reasonably secure** for its intended use case. No SQL injection vulnerabilities exist since no database operations are performed. Main risks are theoretical (require code modifications to expose). Follow recommendations if extending functionality.
