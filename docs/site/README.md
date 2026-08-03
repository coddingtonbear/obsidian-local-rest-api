# Marketing site candidates

Three complete candidate marketing sites for the plugin, plus a chooser page at
`index.html` that links to all three. Nothing here is published as *the* site yet —
they ship under `/site/` so they can be compared in a real browser before one is chosen.

| Directory | Direction | Pitched at |
|---|---|---|
| `terminal/` | Dark, built around a live request/response transcript | Developers evaluating the REST API |
| `datasheet/` | Light, reference-like, full endpoint matrix on the page | People who want to know it is documented |
| `conversation/` | Editorial, built around what an agent does to a vault | People connecting an AI agent |

Each page is a single self-contained `index.html`: no external CSS, JavaScript, fonts,
or images, and so no third-party requests from a site whose whole pitch is that nothing
leaves your machine. They use system font stacks, support light and dark, and carry the
same facts, the same comparison against the alternatives, and the same two calls to
action (install, and the interactive API reference).

## Where they are published

`.github/workflows/deploy-docs.yml` publishes the whole of `docs/` to GitHub Pages on
tag push or manual dispatch, so once merged these are reachable at:

- <https://coddingtonbear.github.io/obsidian-local-rest-api/site/>
- `…/site/terminal/`, `…/site/datasheet/`, `…/site/conversation/`

To see them before a release, run the **Deploy Docs** workflow manually, or serve
locally with `npm run serve-docs` and open `/site/`.

## Promoting the chosen one to the site root

The root URL <https://coddingtonbear.github.io/obsidian-local-rest-api/> currently serves
the Stoplight Elements viewer, and it is referenced from the README, the plugin's
settings pages, the MCP tool descriptions, and third-party documentation. Promotion must
not break it. The intended sequence:

1. Move the Elements viewer to `docs/api/index.html`, keeping `docs/openapi.yaml` where it
   is (adjust the viewer's `apiDescriptionUrl` to `../openapi.yaml`).
2. Leave a redirect at the old root that sends visitors to `/api/`, so every existing link
   keeps working rather than landing on the marketing page.
3. Copy the chosen candidate to `docs/index.html` and repoint its "API docs" links —
   currently absolute — at `/obsidian-local-rest-api/api/`.
4. Update the README, `src/main.ts`'s settings links, and the OpenAPI `externalDocs` URL
   to match.
5. Delete the two candidates that were not chosen, and this directory's chooser page.

Step 2 is the part worth being careful about: the docs URL has been stable for years and
is quoted in places outside this repository.
