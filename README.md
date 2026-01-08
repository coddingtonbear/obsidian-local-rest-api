# Local REST API for Obsidian

See our interactive docs: https://coddingtonbear.github.io/obsidian-local-rest-api/

Have you ever needed to automate interacting with your notes?  This plugin gives Obsidian a REST API you can interact with your notes from other tools so you can automate what you need to automate.

This plugin provides a secure HTTPS interface gated behind api key authentication that allows you to:

- Read, create, update or delete existing notes.  There's even a `PATCH` HTTP method for inserting content into a particular section of a note.
- List notes stored in your vault.
- Create and fetch periodic notes.
- Execute commands and list what commands are available.

This is particularly useful if you need to interact with Obsidian from a browser extension like [Obsidian Web](https://chrome.google.com/webstore/detail/obsidian-web/edoacekkjanmingkbkgjndndibhkegad).

## Credits

This was inspired by [Vinzent03](https://github.com/Vinzent03)'s [advanced-uri plugin](https://github.com/Vinzent03/obsidian-advanced-uri) with hopes of expanding the automation options beyond the limitations of custom URL schemes.

## Rendered Content Support

This plugin can extract fully-rendered content from your notes, including:

- **Dataview queries** - Tables, lists, and task queries are fully executed
- **DataviewJS** - Custom JavaScript blocks are rendered
- **Plugin-generated content** - Metadata Menu, Buttons, and other plugin outputs
- **Dynamic dashboards** - Perfect for AI assistants to see computed views

### Content Formats

**Plain Text** (`application/vnd.olrapi.note+rendered-text`)
- Human-readable text output
- Fast and simple
- Good for general text analysis

**Structured JSON** (`application/vnd.olrapi.note+rendered-json`)
- AI-optimized structured data
- Tables as 2D arrays with headers
- Document hierarchy preserved with type tags
- Complete frontmatter included
- Perfect for programmatic access

### Example Usage

```bash
# Get rendered text
curl -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Accept: application/vnd.olrapi.note+rendered-text" \
     "https://localhost:27124/vault/path/to/note.md"

# Get structured JSON
curl -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Accept: application/vnd.olrapi.note+rendered-json" \
     "https://localhost:27124/vault/path/to/note.md"
```

**JSON Output Structure:**
```json
{
  "metadata": {
    "sourcePath": "path/to/note.md",
    "renderedAt": "2025-01-10T18:00:00.000Z",
    "format": "json",
    "version": "1.0"
  },
  "frontmatter": {
    "tags": ["example"],
    "category": "Documentation"
  },
  "content": [
    {
      "type": "heading",
      "level": 2,
      "text": "Section Title"
    },
    {
      "type": "table",
      "headers": ["Column 1", "Column 2"],
      "rows": [
        ["Value 1", "Value 2"],
        ["Value 3", "Value 4"]
      ]
    }
  ]
}
```

### Caching

Rendered content is cached for performance:
- Cache directory: `.obsidian/render-cache/` (configurable)
- Automatic invalidation on file changes
- Manual cache clearing available in settings
- Cache statistics displayed in plugin settings

