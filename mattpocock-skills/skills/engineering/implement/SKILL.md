---
name: implement
description: >
  按 spec 或 ticket 驱动实现：自动调用 TDD 和代码审查。Implement a piece of work based on a spec or set of tickets.
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, call the Skill tool with "open-code-review-delegate" to review the work before committing.

Commit your work to the current branch.
