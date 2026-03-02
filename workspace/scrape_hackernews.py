#!/usr/bin/env python3
"""
Hacker News Front Page Scraper
Scrapes the front page titles and saves them to a JSON file with timestamps.
"""

import json
import urllib.request
from html.parser import HTMLParser
from datetime import datetime
import os


class HackerNewsParser(HTMLParser):
    """Parser for extracting story titles from Hacker News HTML."""
    
    def __init__(self):
        super().__init__()
        self.stories = []
        self.current_story = {}
        self.in_title_link = False
        self.in_story_title = False
        
    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        
        # Look for story title links (class="titleline")
        if tag == 'span' and attrs_dict.get('class') == 'titleline':
            self.in_story_title = True
        
        # Capture the link inside titleline
        if self.in_story_title and tag == 'a':
            self.in_title_link = True
            self.current_story['url'] = attrs_dict.get('href', '')
    
    def handle_data(self, data):
        if self.in_title_link:
            self.current_story['title'] = data.strip()
    
    def handle_endtag(self, tag):
        if tag == 'a' and self.in_title_link:
            self.in_title_link = False
            if 'title' in self.current_story:
                self.stories.append(self.current_story.copy())
                self.current_story = {}
        
        if tag == 'span' and self.in_story_title:
            self.in_story_title = False


def scrape_hackernews():
    """Scrape Hacker News front page and return stories with metadata."""
    url = 'https://news.ycombinator.com/'
    
    try:
        # Fetch the page
        headers = {'User-Agent': 'Mozilla/5.0 (Python Script)'}
        request = urllib.request.Request(url, headers=headers)
        
        with urllib.request.urlopen(request, timeout=10) as response:
            html_content = response.read().decode('utf-8')
        
        # Parse the HTML
        parser = HackerNewsParser()
        parser.feed(html_content)
        
        # Add timestamp to results
        result = {
            'scraped_at': datetime.now().isoformat(),
            'source': url,
            'story_count': len(parser.stories),
            'stories': parser.stories
        }
        
        return result
    
    except urllib.error.URLError as e:
        print(f"Error fetching Hacker News: {e}")
        return None
    except Exception as e:
        print(f"Unexpected error: {e}")
        return None


def save_to_json(data, filename='hackernews_titles.json'):
    """Save scraped data to a JSON file."""
    try:
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"✓ Saved {data['story_count']} stories to {filename}")
        return True
    except Exception as e:
        print(f"Error saving to JSON: {e}")
        return False


def main():
    """Main function to scrape and save Hacker News stories."""
    print("Scraping Hacker News front page...")
    
    data = scrape_hackernews()
    
    if data:
        # Save to JSON file
        save_to_json(data)
        
        # Print summary
        print(f"\nScraped at: {data['scraped_at']}")
        print(f"Total stories: {data['story_count']}")
        print("\nFirst 5 titles:")
        for i, story in enumerate(data['stories'][:5], 1):
            print(f"{i}. {story['title']}")
    else:
        print("Failed to scrape Hacker News")


if __name__ == '__main__':
    main()
