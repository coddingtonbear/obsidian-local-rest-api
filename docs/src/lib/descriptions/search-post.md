Evaluates a provided query against each file in your vault.

This endpoint supports multiple query formats.  Your query should be specified in your request's body, and will be interpreted according to the `Content-type` header you specify from the below options. Additional query formats may be added in the future.

# Dataview DQL (`application/vnd.olrapi.dataview.dql+txt`)

Accepts a `TABLE`-type Dataview query as a text string.  See [Dataview](https://blacksmithgu.github.io/obsidian-dataview/query/queries/)'s query documentation for information on how to construct a query.

# JsonLogic (`application/vnd.olrapi.jsonlogic+json`)

Accepts a JsonLogic query specified as JSON.  See [JsonLogic](https://jsonlogic.com/operations.html)'s documentation for information about the base set of operators available, but in addition to those operators the following operators are available:

- `glob: [PATTERN, VALUE]`: Returns `true` if a string matches a glob pattern.  E.g.: `{"glob": ["*.foo", "bar.foo"]}` is `true` and `{"glob": ["*.bar", "bar.foo"]}` is `false`.
- `regexp: [PATTERN, VALUE]`: Returns `true` if a string matches a regular expression.  E.g.: `{"regexp": [".*\.foo", "bar.foo"]` is `true` and `{"regexp": [".*\.bar", "bar.foo"]}` is `false`.

Returns only non-falsy results.  "Non-falsy" here treats the following values as "falsy":

- `false`
- `null` or `undefined`
- `0`
- `[]`
- `{}`

Files are represented as an object having the schema described
in the Schema named 'NoteJson' at the bottom of this page.
Understanding the shape of a JSON object from a schema can be
tricky; so you may find it helpful to examine the generated metadata
for individual files in your vault to understand exactly what values
are returned.  To see that, access the `GET` `/vault/{filePath}`
route setting the header:
`Accept: application/vnd.olrapi.note+json`.  See examples below
for working examples of queries performing common search operations.
