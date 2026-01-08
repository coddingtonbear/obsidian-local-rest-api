# Rendered Content API

This document describes the rendered content extraction feature that allows you to retrieve fully-rendered Obsidian notes including all plugin-generated content.

## Overview

When you request a note with the appropriate `Accept` header, the plugin will:

1. Open the note in preview/reading mode
2. Wait for all async content to render (Dataview queries, etc.)
3. Extract the rendered content from the DOM
4. Return it in your requested format (text or JSON)
5. Cache the result for subsequent requests
6. Restore your original view

## Content Types

### Plain Text Format

**Accept Header:** `application/vnd.olrapi.note+rendered-text`

**Returns:** Plain text representation of the rendered note

**Use Cases:**
- General text analysis
- Search indexing
- Quick content preview
- Human-readable output

**Example Request:**
```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Accept: application/vnd.olrapi.note+rendered-text" \
     "https://localhost:27124/vault/Notes/Dashboard.md"
```

**Example Response:**
```
Dashboard

Current Projects

File    Status    Priority
Project A    Active    High
Project B    Planning    Medium

Notes: 156 files
```

### Structured JSON Format

**Accept Header:** `application/vnd.olrapi.note+rendered-json`

**Returns:** Structured JSON with typed content blocks

**Use Cases:**
- AI/LLM integration
- Programmatic data extraction
- Table analysis
- Document structure navigation

**Example Request:**
```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Accept: application/vnd.olrapi.note+rendered-json" \
     "https://localhost:27124/vault/Notes/Dashboard.md"
```

**Example Response:**
```json
{
  "metadata": {
    "sourcePath": "Notes/Dashboard.md",
    "renderedAt": "2025-01-10T18:00:00.000Z",
    "format": "json",
    "version": "1.0"
  },
  "frontmatter": {
    "tags": ["dashboard"],
    "fileClass": "doc",
    "dg-publish": true
  },
  "content": [
    {
      "type": "heading",
      "level": 1,
      "text": "Dashboard"
    },
    {
      "type": "heading",
      "level": 2,
      "text": "Current Projects"
    },
    {
      "type": "table",
      "headers": ["File", "Status", "Priority"],
      "rows": [
        ["Project A", "Active", "High"],
        ["Project B", "Planning", "Medium"]
      ]
    },
    {
      "type": "paragraph",
      "text": "Notes: 156 files"
    }
  ]
}
```

## JSON Schema

### Top-Level Structure

```typescript
interface StructuredContent {
  metadata: {
    sourcePath: string;
    renderedAt: string;  // ISO 8601 timestamp
    format: "json";
    version: "1.0";
  };
  frontmatter: Record<string, any>;
  content: ContentBlock[];
}
```

### Content Block Types

#### HeadingBlock
```typescript
{
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}
```

#### TableBlock
```typescript
{
  type: "table";
  title?: string;
  headers: string[];
  rows: string[][];
}
```

Tables are represented as:
- `headers`: Array of column names
- `rows`: 2D array where each inner array is a row of values

**Example:**
```json
{
  "type": "table",
  "headers": ["Name", "Age", "City"],
  "rows": [
    ["Alice", "30", "NYC"],
    ["Bob", "25", "LA"]
  ]
}
```

#### ListBlock
```typescript
{
  type: "list";
  style: "ordered" | "unordered";
  items: string[];
}
```

#### ParagraphBlock
```typescript
{
  type: "paragraph";
  text: string;
}
```

#### CodeBlock
```typescript
{
  type: "code";
  language?: string;
  code: string;
}
```

#### CalloutBlock
```typescript
{
  type: "callout";
  calloutType: string;  // "note", "warning", "tip", etc.
  title?: string;
  content: string;
}
```

## Caching System

### Cache Location

By default, rendered content is cached in `.obsidian/render-cache/`:

```
.obsidian/render-cache/
├── CacheIndex.json
└── {md5-hash}/
    ├── note.txt
    └── note.json (metadata)
```

### Cache Keys

Cache is keyed by MD5 hash of file content, making it:
- **Content-addressable**: Same content = same cache entry
- **Deduplication-friendly**: Identical files share cache
- **Rename-tolerant**: Moving files doesn't invalidate cache

### Cache Metadata

Each cache entry stores:
```json
{
  "sourcePath": "Notes/Dashboard.md",
  "sourceHash": "abc123...",
  "vaultMtime": 1704902400000,
  "renderedAt": 1704902403000,
  "pdfSize": 0,
  "textSize": 12345
}
```

### Cache Invalidation

**Automatic:**
- File modification triggers cache invalidation
- Vault event listeners detect changes
- Cache is regenerated on next request

**Manual:**
- "Clear Cache" button in plugin settings
- Cache statistics show size and entry count

### Configuration

Settings available in plugin configuration:

- **Cache Directory**: Path to cache location (default: `.obsidian/render-cache`)
- **Max Cache Size**: Size limit in MB (default: 100 MB)
- **Auto Cleanup**: Automatically remove old entries (default: true) *[Not yet implemented]*
- **Render Timeout**: Max wait time for rendering (default: 30000 ms)

## Performance

### Timing

**First Request (Cache Miss):**
- ~2-3 seconds for typical notes
- Includes 2-second wait for async content settlement
- May be longer for complex Dataview queries

**Subsequent Requests (Cache Hit):**
- <100ms (simple file read)
- No rendering overhead

### Bundle Size

- Plugin size: ~2.4 MB
- No external PDF dependencies
- Minimal overhead for JSON serialization

### Response Size

**Text Format:**
- Typical dashboard: ~6 KB
- Most notes: <10 KB

**JSON Format:**
- Typical dashboard: ~15 KB
- Ratio: ~2.5x larger than text
- Still well under 100 KB for most notes

## Use Cases

### AI Assistant Integration

```python
import requests

# Get structured data
response = requests.get(
    "https://localhost:27124/vault/Notes/Dashboard.md",
    headers={
        "Authorization": "Bearer YOUR_API_KEY",
        "Accept": "application/vnd.olrapi.note+rendered-json"
    },
    verify=False
)

data = response.json()

# Access tables
tables = [block for block in data["content"] if block["type"] == "table"]

# Convert to pandas DataFrame
import pandas as pd
for table in tables:
    df = pd.DataFrame(table["rows"], columns=table["headers"])
    # Analyze, filter, etc.
```

### Document Analysis

```javascript
const response = await fetch(url, {
  headers: { "Accept": "application/vnd.olrapi.note+rendered-json" }
});
const { content } = await response.json();

// Build table of contents
const toc = content
  .filter(b => b.type === "heading")
  .map(h => ({ level: h.level, text: h.text }));

// Find all tables
const tables = content.filter(b => b.type === "table");

// Get all code blocks
const code = content.filter(b => b.type === "code");
```

### Search & Indexing

```python
# Index rendered content for search
def index_note(path):
    response = requests.get(
        f"https://localhost:27124/vault/{path}",
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Accept": "application/vnd.olrapi.note+rendered-text"
        }
    )

    # Index the rendered text (includes Dataview results)
    search_index.add_document(path, response.text)
```

## Supported Plugins

The rendered content includes output from:

- **Dataview** - Tables, lists, task queries
- **DataviewJS** - Custom JavaScript rendering
- **Metadata Menu** - Field widgets and dropdowns
- **Buttons** - Button plugin output
- **Callouts** - Native Obsidian callouts
- **Tasks** - Task plugin queries
- **Any plugin** that renders to the preview pane

## Limitations

### Known Issues

1. **Table Header Formatting**
   - Dataview may include row counts in headers (e.g., `File14` instead of `File`)
   - This is cosmetic and easily parsed by clients
   - Row count is redundant with `rows.length`

2. **UI Flash**
   - File briefly opens in active pane during rendering
   - Original view is restored after ~2-3 seconds
   - Mitigated by fast caching

3. **Content Settlement**
   - Fixed 2-second wait for async content
   - May be insufficient for very complex queries
   - Configurable via `Render Timeout` setting

4. **No Streaming**
   - Entire content loaded into memory
   - May be slow for very large notes
   - Future enhancement: streaming support

### Not Supported

- Real-time updates (use cache invalidation)
- Selective block rendering
- Interactive elements (buttons, forms)
- Canvas rendering
- PDF embeds (only the embed marker)

## Troubleshooting

### Empty or Incomplete Tables

**Problem:** Tables show empty or missing data

**Solution:**
- Increase render timeout in settings
- Check Dataview query syntax
- Verify plugins are enabled and working

### Cache Not Invalidating

**Problem:** Changes don't appear in rendered output

**Solution:**
- Manually clear cache via settings
- Check file modification time
- Restart Obsidian if vault events aren't triggering

### Slow Performance

**Problem:** Requests take >5 seconds

**Solution:**
- Check Dataview query complexity
- Reduce number of dynamic blocks
- Increase render timeout (but diminishing returns)
- Consider caching strategy

### JSON Parse Errors

**Problem:** Invalid JSON returned

**Solution:**
- Check Obsidian console for errors
- Verify plugin is latest version
- Report issue with note structure

## Migration from Other Methods

### From Raw Markdown

**Before:**
```bash
curl "https://localhost:27124/vault/Dashboard.md"
```

Returns raw markdown with Dataview code blocks.

**After:**
```bash
curl -H "Accept: application/vnd.olrapi.note+rendered-text" \
     "https://localhost:27124/vault/Dashboard.md"
```

Returns fully-rendered output with tables populated.

### From HTML Output

**Before:**
```bash
curl -H "Accept: application/vnd.olrapi.note+html" \
     "https://localhost:27124/vault/Dashboard.md"
```

Returns HTML (may have incomplete plugin rendering).

**After:**
```bash
curl -H "Accept: application/vnd.olrapi.note+rendered-json" \
     "https://localhost:27124/vault/Dashboard.md"
```

Returns structured JSON with guaranteed complete rendering.

## Security Considerations

### Authentication

All rendered content endpoints require:
- Valid API key in `Authorization` header
- Same authentication as other endpoints
- No additional permissions needed

### Information Disclosure

**Be aware:**
- Frontmatter may contain sensitive metadata
- Rendered content includes all note data
- Cache is stored in `.obsidian/` (not synced by default)

**Mitigation:**
- Protect API key carefully
- Use HTTPS only
- Review cache location if syncing vault

### No Code Execution

- Extraction is read-only
- No user input in extraction logic
- DataviewJS runs in Obsidian's sandbox
- Safe to expose to trusted AI assistants

## Future Enhancements

Potential improvements under consideration:

1. **Link Extraction** - Include wiki-links in JSON output
2. **Image/Embed Support** - Include embedded content
3. **Streaming** - Support for very large notes
4. **Caching JSON** - Separate cache for JSON format
5. **Mutation Observer** - Smarter content settlement detection
6. **LRU Eviction** - Automatic cache size management
7. **Query Metadata** - Include source Dataview queries in output

## API Reference

### Endpoints

**GET /vault/:path**

**Query Parameters:** None

**Headers:**
- `Authorization: Bearer {API_KEY}` - Required
- `Accept: application/vnd.olrapi.note+rendered-text` - For text output
- `Accept: application/vnd.olrapi.note+rendered-json` - For JSON output

**Response Headers:**
- `Content-Type: text/plain; charset=utf-8` (text mode)
- `Content-Type: application/json; charset=utf-8` (JSON mode)
- `X-Rendered-At: {ISO8601}` - Rendering timestamp

**Status Codes:**
- `200 OK` - Success
- `400 Bad Request` - Not a markdown file
- `404 Not Found` - File doesn't exist
- `500 Internal Server Error` - Rendering failed

## Support

For issues, feature requests, or questions:
- GitHub Issues: [obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api/issues)
- Include example note structure if reporting rendering issues
- Check console logs for error details
