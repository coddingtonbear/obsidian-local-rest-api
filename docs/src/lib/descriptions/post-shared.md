When a target is specified the content is appended within that section and the full updated file content is returned with a `200` status. Without a target, the content is appended to the end of the file and a `204` status is returned.

If you need `prepend` or `replace` operations, use `PATCH` instead.
