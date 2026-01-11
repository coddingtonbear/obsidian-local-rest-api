# How can I contribute?

Thanks for your interest in contributing! Contributions are welcome, but a bit of coordination up front goes a long way toward ensuring everyone’s time is well spent.

## Start with a Discussion

Before opening a pull request—especially for **new features or behavioral changes**—please start a discussion first:

👉 [https://github.com/coddingtonbear/obsidian-local-rest-api/discussions](https://github.com/coddingtonbear/obsidian-local-rest-api/discussions)

This helps confirm that the idea aligns with the project’s direction and avoids contributors investing time in changes that ultimately won’t be merged.

## Consider an API Extension First

If you’re looking to add new functionality that doesn’t currently exist in the API, you may want to consider building an **API extension** instead of modifying the core project:

👉 [https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Adding-your-own-API-Routes-via-an-Extension](https://github.com/coddingtonbear/obsidian-local-rest-api/wiki/Adding-your-own-API-Routes-via-an-Extension)

API extensions:

- Are not subject to any gatekeeping by the core project
- Can be developed and released independently
- Are often a better fit for experimental or niche features

Not all ideas need to live in core to be useful.

## Contribution Expectations

### Project Direction & Scope

- Contributions are evaluated based on **alignment with the project’s design goals and philosophy**, not just correctness.
- Bug fixes are generally easier to accept than new features.
- Not all well-implemented contributions are guaranteed to be merged.
    
### API Design

- Any new APIs **must be REST-ful**, or as REST-ful as is reasonably achievable given constraints.
- Consistency with existing API patterns is strongly preferred.
- Backward-incompatible changes are **discouraged**, though not strictly forbidden; if a breaking change is proposed, it should be clearly justified and discussed in advance.
    

### Tests & Documentation

All contributions that modify behavior or add features are expected to:

- Update or add tests covering the new behavior
- Update documentation to describe the change or new functionality
    
Changes without corresponding tests or documentation are unlikely to be accepted.

### Scope & Quality

- Pull requests should remain **narrowly scoped** to the problem they intend to solve.
- Unrelated refactors, cleanup, or stylistic changes should be avoided unless discussed beforehand.
- CI failures or linting issues should be resolved before review.

### Ownership & Follow-Through

- Contributors are expected to **actively shepherd their pull requests**, including responding to feedback and making requested changes.
- Maintainers may make small edits, but won’t complete large reworks on a contributor’s behalf.
- Pull requests that see **no forward progress for 90 days** may be closed due to inactivity.

## Communication & Conduct

- Please communicate respectfully and patiently.
- Maintainers work on this project in their limited free time; demands for timelines or merges are discouraged.
- Questions, suggestions, and constructive disagreement are welcome—but entitlement or pressure is not.
