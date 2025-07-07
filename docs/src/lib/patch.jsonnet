{
  parameters: [
    {
      name: 'Operation',
      'in': 'header',
      description: 'Patch operation to perform',
      required: true,
      schema: {
        type: 'string',
        enum: [
          'append',
          'prepend',
          'replace',
          'rename',
        ],
      },
    },
    {
      name: 'Target-Type',
      'in': 'header',
      description: 'Type of target to patch',
      required: true,
      schema: {
        type: 'string',
        enum: [
          'heading',
          'block',
          'frontmatter',
          'file',
        ],
      },
    },
    {
      name: 'Target-Delimiter',
      'in': 'header',
      description: 'Delimiter to use for nested targets (i.e. Headings)',
      required: false,
      schema: {
        type: 'string',
        default: '::',
      },
    },
    {
      name: 'Target',
      'in': 'header',
      description: |||
        Target to patch; this value can be URL-Encoded and *must*
        be URL-Encoded if it includes non-ASCII characters.
        
        For file operations:
        - When Operation is 'rename' and Target-Type is 'file': Target should be the new filename
      |||,
      required: true,
      schema: {
        type: 'string',
      },
    },
    {
      name: 'Create-Target-If-Missing',
      'in': 'header',
      description: 'If specified Target does not exist, create it?',
      required: false,
      schema: {
        type: 'string',
        enum: [
          'true',
          'false',
        ],
        default: 'false',
      },
    }
    {
      name: 'Apply-If-Content-Preexists',
      'in': 'header',
      description: 'If patch data already exists in Target, apply patch anyway?',
      required: false,
      schema: {
        type: 'string',
        enum: [
          'true',
          'false',
        ],
        default: 'false',
      },
    }
    {
      name: 'Trim-Target-Whitespace',
      'in': 'header',
      description: 'Trim whitespace from Target before applying patch?',
      required: false,
      schema: {
        type: 'string',
        enum: [
          'true',
          'false',
        ],
        default: 'false',
      },
    },
  ],
  requestBody: {
    description: 'Content you would like to insert.',
    required: true,
    content: {
      'text/markdown': {
        schema: {
          type: 'string',
          example: '# This is my document\n\nsomething else here\n',
        },
      },
      'application/json': {
        schema: {
          type: 'string',
          example: "['one', 'two']",
        },
      },
    },
  },
  responses: {
    '200': {
      description: 'Success',
    },
    '400': {
      description: 'Bad Request; see response message for details.',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '404': {
      description: 'Does not exist',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
    '405': {
      description: 'Your path references a directory instead of a file; this request method is valid only for updating files.\n',
      content: {
        'application/json': {
          schema: {
            '$ref': '#/components/schemas/Error',
          },
        },
      },
    },
  },
  description: |||
    Allows you to modify the content relative to a heading, block reference, or frontmatter field in your document.

    Note that this API was changed in Version 3.0 of this extension and the earlier PATCH API is now deprecated. Requests made using the previous version of this API will continue to work until Version 4.0 is released.  See https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Changes-to-PATCH-requests-between-versions-2.0-and-3.0 for more details and migration instructions.

    # Examples

    All of the below examples assume you have a document that looks like
    this:

    ```markdown
    ---
    alpha: 1
    beta: test
    delta:
    zeta: 1
    yotta: 1
    gamma:
    - one
    - two
    ---

    # Heading 1

    This is the content for heading one

    Also references some [[#^484ef2]]

    ## Subheading 1:1
    Content for Subheading 1:1

    ### Subsubheading 1:1:1

    ### Subsubheading 1:1:2

    Testing how block references work for a table.[[#^2c7cfa]]
    Some content for Subsubheading 1:1:2

    More random text.

    ^2d9b4a

    ## Subheading 1:2

    Content for Subheading 1:2.

    some content with a block reference ^484ef2

    ## Subheading 1:3
    | City         | Population |
    | ------------ | ---------- |
    | Seattle, WA  | 8          |
    | Portland, OR | 4          |

    ^2c7cfa
    ```

    ## Append, Prepend, or Replace Content Below a Heading

    If you wanted to append the content "Hello" below "Subheading 1:1:1" under "Heading 1",
    you could send a request with the following headers:

    - `Operation`: `append`
    - `Target-Type`: `heading`
    - `Target`: `Heading 1::Subheading 1:1:1`
    - with the request body: `Hello`

    The above would work just fine for `prepend` or `replace`, too, of course,
    but with different results.

    ## Append, Prepend, or Replace Content to a Block Reference

    If you wanted to append the content "Hello" below the block referenced by
    "2d9b4a" above ("More random text."), you could send the following headers:

    - `Operation`: `append`
    - `Target-Type`: `block`
    - `Target`: `2d9b4a`
    - with the request body: `Hello`

    The above would work just fine for `prepend` or `replace`, too, of course,
    but with different results.

    ## Append, Prepend, or Replace a Row or Rows to/in a Table Referenced by a Block Reference

    If you wanted to add a new city ("Chicago, IL") and population ("16") pair to the table above
    referenced by the block reference `2c7cfa`, you could send the following
    headers:

    - `Operation`: `append`
    - `TargetType`: `block`
    - `Target`: `2c7cfa`
    - `Content-Type`: `application/json`
    - with the request body: `[["Chicago, IL", "16"]]`

    The use of a `Content-Type` of `application/json` allows the API
    to infer that member of your array represents rows and columns of your
    to append to the referenced table.  You can of course just use a
    `Content-Type` of `text/markdown`, but in such a case you'll have to
    format your table row manually instead of letting the library figure
    it out for you.

    You also have the option of using `prepend` (in which case, your new
    row would be the first -- right below the table heading) or `replace` (in which
    case all rows except the table heading would be replaced by the new row(s)
    you supplied).

    ## Setting a Frontmatter Field

    If you wanted to set the frontmatter field `alpha` to `2`, you could
    send the following headers:

    - `Operation`: `replace`
    - `TargetType`: `frontmatter`
    - `Target`: `beep`
    - with the request body `2`

    If you're setting a frontmatter field that might not already exist
    you may want to use the `Create-Target-If-Missing` header so the
    new frontmatter field is created and set to your specified value
    if it doesn't already exist.

    You may find using a `Content-Type` of `application/json` to be
    particularly useful in the case of frontmatter since frontmatter
    fields' values are JSON data, and the API can be smarter about
    interpreting yoru `prepend` or `append` requests if you specify
    your data as JSON (particularly when appending, for example,
    list items).

    ## File Rename Operation

    ### Renaming a File

    To rename a file, use:
    - `Operation`: `rename`
    - `Target-Type`: `file`
    - `Target`: `newfilename.md`
    - Request body: empty

    File rename operations preserve internal links within your vault.
  |||,
}
