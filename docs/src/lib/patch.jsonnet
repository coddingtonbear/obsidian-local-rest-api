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
      description: 'Target to patch',
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

    ## Append Content Below a Heading

    If you wanted to append the content "Hello" below "Subheading 1:1:1" under "Heading 1",
    you could send a request with the following headers:

    - `Operation`: `append`
    - `Target-Type`: `heading`
    - `Target`: `Heading 1::Subheading 1:1:1`
    - with the request body: `Hello`

    The above would work just fine for `prepend` or `replace`, too, of course,
    but with different results.

    ## Append Content to a Block Reference

    If you wanted to append the content "Hello" below the block referenced by
    "2d9b4a" above ("More random text."), you could send the following headers:

    - `Operation`: `append`
    - `Target-Type`: `block`
    - `Target`: `2d9b4a`
    - with the request body: `Hello`

    The above would work just fine for `prepend` or `replace`, too, of course,
    but with different results.

    ## Add a Row to a Table Referenced by a Block Reference

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

    # Upgrading from Version 2.0 (heading-based) to Version 3.0 (target-based) APIs

    This API was changed in version 3.0 of Obsidian Local REST API to support making changes to your document relative to ["block references"](https://help.obsidian.md/Linking+notes+and+files/Internal+links#Link+to+a+block+in+a+note) and frontmatter fields in addition to headings within your document. 
    Version 2.0 of this API (now undocumented) is still accessible as
    long as your incoming request specifies the `Heading` header and
    *does not* specify a `Target-Type` header.  You should upgrade, though,
    to the current version of the API as support for the Version 2.0 API is
    now deprecated and will stop working in Version 4.0.

    You can migrate to the current version of the API by following the below guidelines. The words "heading" and "header" both occur quite a lot in the below paragraphs so it may aid in your understanding if you keep in mind that "head**ing**" here refers to a heading existing within your markdown document and "head**er**" refers to an HTTP Header that you may set to a value as part of using this API.

    1. Rename your `Heading` header to `Target`.
    2. Add a new `Target-Type` header having the value `heading`.
    3. Set the `Operation` header such that its value is `append` if you had either not set the `Content-Insertion-Position` header or had set it to `end`. Set it to `prepend` if you had set `Content-Insertion-Position` to `beginning`.
    4. If you had set `Content-Insertion-Ignore-Newline` to `true`, set the `Trim-Target-Whitespace` header value to `true` also.

    Aside from the above, there is one important thing to keep in mind: while the obsolete version of this API allowed you to specify just the terminal heading (e.g. content under `### My Heading` could be addressed by setting the `Heading` header to `My Heading`), the current version of this API requires that you provide the full path to your target heading (i.e. instead of `My Heading`, you must find the parent second level heading and and its parent top level heading) delimited by `::`.  If `::` appears in your heading, you can override that value by setting the `Target-Delimiter` header.

    For example, if you had previously set `Heading` to `My Heading` for adding content to "MY CONTENT" in a document like:

    ```markdown
    # Some top-level heading

    ## Some second-level heading

    ### My Heading

    MY CONTENT
    ```

    you should now set yoru `Target` heading to `Some top-level heading::Some second-level heading::My Heading`.
  |||,
}
