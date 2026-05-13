export const TEST_DIR  = "__integration_tests__";
export const TEST_PATH = `${TEST_DIR}/fixture.md`;

// Unique search terms per section — unlikely to appear in any real vault content
export const TERM_ALPHA = "xylophone-alpha-unique";
export const TERM_SUB   = "xylophone-sub-unique";
export const TERM_BETA  = "xylophone-beta-unique";
export const TERM_DELTA = "xylophone-delta-unique";

// Section heading names — single words so no percent-encoding needed in URL targets
export const HEADING_ALPHA = "Alpha";
export const HEADING_SUB   = "Subsection";
export const HEADING_BETA  = "Beta";
export const HEADING_GAMMA = "Gamma";
export const HEADING_DELTA = "Delta";

// Block IDs used in the fixture
export const BLOCK_BETA  = "beta-block";
export const BLOCK_TABLE = "table-block";

// Frontmatter keys and expected values
export const FM_TITLE          = "title";
export const FM_TAGS           = "tags";
export const FM_PRIORITY       = "priority";
export const FM_ACTIVE         = "active";
export const FM_TITLE_VALUE    = "Integration Test Fixture";
export const FM_PRIORITY_VALUE = 42;
export const FM_ACTIVE_VALUE   = true;

// Tag names used in the fixture
export const TAG_FIXTURE = "integration-fixture";
export const TAG_TEST    = "test-tag";
export const TAG_INLINE  = "inline-tag";

export const FIXTURE_DOCUMENT = `---
title: Integration Test Fixture
tags:
  - integration-fixture
  - test-tag
priority: 42
active: true
---

# Alpha

Primary content of Alpha. #inline-tag

A second paragraph with unique text: xylophone-alpha-unique.

## Subsection

Content inside Subsection nested under Alpha. xylophone-sub-unique.

# Beta

Content in Beta. xylophone-beta-unique. ^beta-block

A second paragraph in Beta after the block reference.

# Gamma

This section contains a table.

| Column A | Column B |
|----------|----------|
| Row 1 A  | Row 1 B  |
| Row 2 A  | Row 2 B  | ^table-block

A paragraph after the table in Gamma.

# Delta

Content in Delta for append and prepend tests. xylophone-delta-unique.
`;
